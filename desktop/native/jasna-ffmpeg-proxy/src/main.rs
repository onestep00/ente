use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::time::Instant;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_UNABLE_TO_REMOVE_REPLACED},
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING},
};

const JOB_ENV: &str = "ENTE_JASNA_FFMPEG_JOB";
const REAL_FFMPEG_ENV: &str = "ENTE_JASNA_REAL_FFMPEG";
#[cfg(windows)]
const STATUS_PUBLISH_RETRY_LIMIT: Duration = Duration::from_secs(2);
#[cfg(windows)]
const STATUS_PUBLISH_RETRY_DELAY: Duration = Duration::from_millis(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    version: u32,
    job_id: String,
    input_path: String,
    output_dir: String,
    key_info_path: String,
    status_path: String,
    duration_seconds: f64,
    source_fps: Option<f64>,
    segment_duration: f64,
    min_bitrate: u64,
    target_bitrate: u64,
    max_bitrate: u64,
    max_fps: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status<'a> {
    version: u32,
    job_id: &'a str,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("ente Jasna FFmpeg proxy: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<i32, String> {
    let args: Vec<String> = env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if args.first().is_some_and(|arg| arg == "--ente-jasna-host") {
        return run_jasna_host(&args[1..]);
    }
    if args.first().is_some_and(|arg| arg == "--ente-jasna-child") {
        return run_jasna_child(&args[1..]);
    }
    let real_ffmpeg = real_ffmpeg_path()?;
    let Some(job_location) = env::var_os(JOB_ENV) else {
        return run_passthrough(&real_ffmpeg, &args);
    };
    if !is_streaming_invocation(&args) {
        return run_passthrough(&real_ffmpeg, &args);
    }
    let job_location = PathBuf::from(job_location);
    let job = select_job(&job_location, &args)?;
    if !input_matches(&args, &job.input_path) {
        return fail_job(&job, "FFmpeg input does not match the active Ente job");
    }

    let rewritten = rewrite_streaming_args(&args, &job)?;
    write_status(&job, "started", Some(0.0), None)?;
    let mut child = Command::new(&real_ffmpeg)
        .args(&rewritten)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("start real FFmpeg: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "real FFmpeg stdout is unavailable".to_owned())?;
    let heartbeat = Heartbeat::start(&job);
    let mut out_time_us = 0_u64;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("read FFmpeg progress: {error}"))?;
        if let Some(value) = line.strip_prefix("out_time_us=") {
            out_time_us = value.parse().unwrap_or(out_time_us);
        } else if line == "progress=continue" && job.duration_seconds > 0.0 {
            let progress =
                (out_time_us as f64 / 1_000_000.0 / job.duration_seconds).clamp(0.0, 0.999);
            write_status(&job, "running", Some(progress), None)?;
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("wait for real FFmpeg: {error}"))?;
    drop(heartbeat);
    if let Err(error) = cleanup_temporary_output(&job) {
        write_status(&job, "error", None, Some(error.clone()))?;
        return Ok(1);
    }
    if status.success() {
        write_status(&job, "complete", Some(1.0), None)?;
        Ok(0)
    } else {
        let code = status.code().unwrap_or(1);
        write_status(
            &job,
            "error",
            None,
            Some(format!("FFmpeg exited with code {code}")),
        )?;
        Ok(code)
    }
}

fn read_job(path: &Path) -> Result<Job, String> {
    let job: Job = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("read job {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("parse job {}: {error}", path.display()))?;
    validate_job(&job)?;
    Ok(job)
}

fn select_job(location: &Path, args: &[String]) -> Result<Job, String> {
    if location.is_file() {
        return read_job(location);
    }
    if !location.is_dir() {
        return Err("refusing Jasna streaming without an active Ente job".to_owned());
    }

    let mut candidates = Vec::new();
    for entry in fs::read_dir(location)
        .map_err(|error| format!("read jobs directory {}: {error}", location.display()))?
    {
        let entry = entry.map_err(|error| format!("read jobs directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let job = read_job(&path)?;
        if input_matches(args, &job.input_path) {
            candidates.push(job);
        }
    }

    if let Some(index) = candidates
        .iter()
        .position(|job| invocation_mentions_job(args, job))
    {
        return Ok(candidates.swap_remove(index));
    }
    match candidates.len() {
        1 => Ok(candidates.pop().unwrap()),
        0 => Err("no active Ente job matches the Jasna FFmpeg input".to_owned()),
        _ => Err("multiple active Ente jobs match the Jasna FFmpeg input".to_owned()),
    }
}

fn invocation_mentions_job(args: &[String], job: &Job) -> bool {
    let safe_id: String = job
        .job_id
        .chars()
        .take(64)
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == '-' || value == '_' {
                value
            } else {
                '_'
            }
        })
        .collect();
    args.iter()
        .any(|arg| arg.contains(&job.job_id) || arg.contains(&safe_id))
}

fn heartbeat_path(job: &Job) -> PathBuf {
    PathBuf::from(format!("{}.heartbeat", job.status_path))
}

struct Heartbeat {
    path: PathBuf,
    running: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Heartbeat {
    fn start(job: &Job) -> Self {
        let path = heartbeat_path(job);
        let running = Arc::new(AtomicBool::new(true));
        let thread_running = Arc::clone(&running);
        let thread_path = path.clone();
        let thread = thread::spawn(move || {
            while thread_running.load(Ordering::Acquire) {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let _ = fs::write(&thread_path, now.to_string());
                thread::park_timeout(Duration::from_secs(1));
            }
        });
        Self {
            path,
            running,
            thread: Some(thread),
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
        let _ = fs::remove_file(&self.path);
    }
}

fn cleanup_temporary_output(job: &Job) -> Result<(), String> {
    let path = Path::new(&job.output_dir).join("output.ts.tmp");
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove temporary HLS output: {error}")),
    }
}

#[cfg(windows)]
fn run_jasna_host(args: &[String]) -> Result<i32, String> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForMultipleObjects, PROCESS_SYNCHRONIZE,
    };

    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| "host command separator is missing".to_owned())?;
    if separator != 1 || args.len() <= separator + 1 {
        return Err("host usage: --ente-jasna-host <parent-pid> -- <command> [args]".to_owned());
    }
    let parent_pid: u32 = args[0]
        .parse()
        .map_err(|_| "host parent PID is invalid".to_owned())?;
    let command = &args[separator + 1];
    let command_args = &args[separator + 2..];

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(last_os_error("create Jasna job object"));
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err(last_os_error("configure Jasna job object"));
        }

        let mut child_args = vec!["--ente-jasna-child".to_owned(), "--".to_owned()];
        child_args.push(command.clone());
        child_args.extend(command_args.iter().cloned());
        let mut child = Command::new(
            env::current_exe().map_err(|error| format!("resolve host executable: {error}"))?,
        )
        .args(child_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("start Jasna launcher: {error}"))?;
        let child_process = child.as_raw_handle() as HANDLE;
        if AssignProcessToJobObject(job, child_process) == 0 {
            let _ = child.kill();
            CloseHandle(job);
            return Err(last_os_error("assign Jasna launcher to job object"));
        }
        let parent = OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid);
        if parent.is_null() {
            TerminateJobObject(job, 1);
            CloseHandle(job);
            return Err(last_os_error("open Ente parent process"));
        }
        child
            .stdin
            .take()
            .ok_or_else(|| "Jasna launcher stdin is unavailable".to_owned())?
            .write_all(&[1])
            .map_err(|error| format!("release Jasna launcher: {error}"))?;

        let handles: [HANDLE; 2] = [parent, child.as_raw_handle() as HANDLE];
        let wait = WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, u32::MAX);
        if wait == WAIT_OBJECT_0 {
            TerminateJobObject(job, 1);
        }
        let code = child
            .wait()
            .map_err(|error| format!("wait for Jasna: {error}"))?;
        CloseHandle(parent);
        CloseHandle(job);
        Ok(code.code().unwrap_or(1))
    }
}

fn run_jasna_child(args: &[String]) -> Result<i32, String> {
    if args.first().is_none_or(|arg| arg != "--") || args.len() < 2 {
        return Err("child usage: --ente-jasna-child -- <command> [args]".to_owned());
    }
    let mut signal = [0_u8; 1];
    std::io::stdin()
        .read_exact(&mut signal)
        .map_err(|error| format!("wait for Jasna launch signal: {error}"))?;
    Command::new(&args[1])
        .args(&args[2..])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("run Jasna: {error}"))
        .map(|status| status.code().unwrap_or(1))
}

#[cfg(not(windows))]
fn run_jasna_host(_args: &[String]) -> Result<i32, String> {
    Err("Jasna process hosting is available only on Windows".to_owned())
}

#[cfg(windows)]
fn last_os_error(action: &str) -> String {
    format!("{action}: {}", std::io::Error::last_os_error())
}

fn real_ffmpeg_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os(REAL_FFMPEG_ENV) {
        return Ok(PathBuf::from(path));
    }
    let executable = env::current_exe().map_err(|error| format!("resolve proxy path: {error}"))?;
    Ok(executable.with_file_name("ffmpeg.jasna.exe"))
}

fn validate_job(job: &Job) -> Result<(), String> {
    if job.version != 1 {
        return Err(format!("unsupported job version {}", job.version));
    }
    if job.job_id.is_empty() || job.input_path.is_empty() {
        return Err("job ID and input path are required".to_owned());
    }
    if !(job.min_bitrate <= job.target_bitrate && job.target_bitrate <= job.max_bitrate) {
        return Err("bitrate values must satisfy min <= target <= max".to_owned());
    }
    if job.max_fps == 0 || job.segment_duration <= 0.0 || job.duration_seconds <= 0.0 {
        return Err("FPS and durations must be positive".to_owned());
    }
    Ok(())
}

fn is_streaming_invocation(args: &[String]) -> bool {
    has_pair(args, "-f", "rawvideo")
        && has_pair(args, "-i", "pipe:0")
        && has_pair(args, "-f", "hls")
}

fn input_matches(args: &[String], expected: &str) -> bool {
    args.windows(2).any(|pair| {
        pair[0] == "-i"
            && pair[1] != "pipe:0"
            && normalized_path(&pair[1]) == normalized_path(expected)
    })
}

fn normalized_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn has_pair(args: &[String], option: &str, value: &str) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == option && pair[1] == value)
}

fn rewrite_streaming_args(args: &[String], job: &Job) -> Result<Vec<String>, String> {
    let pipe_input = args
        .windows(2)
        .position(|pair| pair[0] == "-i" && pair[1] == "pipe:0")
        .map(|index| index + 1)
        .ok_or_else(|| "rawvideo pipe input is missing".to_owned())?;
    let jasna_fps = input_rate(args, pipe_input)?;
    let source_fps = job
        .source_fps
        .filter(|fps| fps.is_finite() && *fps > 0.0)
        .unwrap_or(jasna_fps);
    let output_fps = source_fps.min(job.max_fps as f64);
    let gop = (output_fps * job.segment_duration).round().max(1.0) as u64;

    let mut rewritten = args[..=pipe_input].to_vec();
    set_input_rate(&mut rewritten, pipe_input, source_fps)?;
    let mut filters = Vec::new();
    let mut index = pipe_input + 1;
    while index < args.len().saturating_sub(1) {
        let option = &args[index];
        if option == "-vf" {
            let value = args
                .get(index + 1)
                .ok_or_else(|| "-vf value is missing".to_owned())?;
            filters.extend(
                value
                    .split(',')
                    .filter(|filter| !filter.starts_with("fps="))
                    .map(str::to_owned),
            );
            index += 2;
        } else if replaced_option(option) {
            index += 2;
        } else if option == "-nostats" {
            index += 1;
        } else {
            rewritten.push(option.clone());
            index += 1;
        }
    }

    if source_fps > job.max_fps as f64 {
        filters.push(format!("fps={}/1", job.max_fps));
    }
    rewritten.extend(option_pairs(job, gop));
    if !filters.is_empty() {
        rewritten.extend(["-vf".to_owned(), filters.join(",")]);
    }
    rewritten.extend([
        "-progress".to_owned(),
        "pipe:1".to_owned(),
        "-nostats".to_owned(),
        "-hls_segment_filename".to_owned(),
        Path::new(&job.output_dir)
            .join("output.ts")
            .to_string_lossy()
            .into_owned(),
        "-hls_key_info_file".to_owned(),
        job.key_info_path.clone(),
        "-hls_flags".to_owned(),
        "single_file".to_owned(),
        Path::new(&job.output_dir)
            .join("output.m3u8")
            .to_string_lossy()
            .into_owned(),
    ]);
    Ok(rewritten)
}

fn input_rate(args: &[String], pipe_input: usize) -> Result<f64, String> {
    let value = (0..pipe_input)
        .rev()
        .find(|index| args[*index] == "-r")
        .and_then(|index| args.get(index + 1))
        .ok_or_else(|| "rawvideo input rate is missing".to_owned())?;
    parse_rate(value)
}

fn set_input_rate(args: &mut [String], pipe_input: usize, fps: f64) -> Result<(), String> {
    let value_index = (0..pipe_input)
        .rev()
        .find(|index| args[*index] == "-r")
        .map(|index| index + 1)
        .ok_or_else(|| "rawvideo input rate is missing".to_owned())?;
    args[value_index] = format!("{fps:.6}");
    Ok(())
}

fn parse_rate(value: &str) -> Result<f64, String> {
    if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator: f64 = numerator
            .parse()
            .map_err(|_| format!("invalid rate {value}"))?;
        let denominator: f64 = denominator
            .parse()
            .map_err(|_| format!("invalid rate {value}"))?;
        if denominator <= 0.0 {
            return Err(format!("invalid rate {value}"));
        }
        Ok(numerator / denominator)
    } else {
        value.parse().map_err(|_| format!("invalid rate {value}"))
    }
}

fn replaced_option(option: &str) -> bool {
    matches!(
        option,
        "-c:v"
            | "-preset"
            | "-tune"
            | "-multipass"
            | "-rc"
            | "-b:v"
            | "-minrate"
            | "-maxrate"
            | "-bufsize"
            | "-cq"
            | "-bf"
            | "-b_ref_mode"
            | "-profile:v"
            | "-spatial-aq"
            | "-aq-strength"
            | "-temporal-aq"
            | "-rc-lookahead"
            | "-g"
            | "-keyint_min"
            | "-sc_threshold"
            | "-pix_fmt"
            | "-c:a"
            | "-b:a"
            | "-hls_segment_filename"
            | "-hls_key_info_file"
            | "-hls_flags"
            | "-progress"
    )
}

fn option_pairs(job: &Job, gop: u64) -> Vec<String> {
    [
        ("-c:v", "h264_nvenc".to_owned()),
        ("-preset", "p7".to_owned()),
        ("-tune", "hq".to_owned()),
        ("-multipass", "fullres".to_owned()),
        ("-rc", "vbr".to_owned()),
        ("-b:v", job.target_bitrate.to_string()),
        ("-minrate", job.min_bitrate.to_string()),
        ("-maxrate", job.max_bitrate.to_string()),
        ("-bufsize", (job.max_bitrate * 2).to_string()),
        ("-cq", "17".to_owned()),
        ("-bf", "4".to_owned()),
        ("-b_ref_mode", "middle".to_owned()),
        ("-profile:v", "high".to_owned()),
        ("-spatial-aq", "1".to_owned()),
        ("-aq-strength", "8".to_owned()),
        ("-temporal-aq", "1".to_owned()),
        ("-rc-lookahead", "32".to_owned()),
        ("-g", gop.to_string()),
        ("-keyint_min", gop.to_string()),
        ("-sc_threshold", "0".to_owned()),
        ("-pix_fmt", "yuv420p".to_owned()),
        ("-c:a", "aac".to_owned()),
        ("-b:a", "192k".to_owned()),
    ]
    .into_iter()
    .flat_map(|(option, value)| [option.to_owned(), value])
    .collect()
}

fn write_status(
    job: &Job,
    state: &str,
    progress: Option<f64>,
    error: Option<String>,
) -> Result<(), String> {
    let path = Path::new(&job.status_path);
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    let value = Status {
        version: 1,
        job_id: &job.job_id,
        state,
        progress,
        error,
    };
    fs::write(
        &temporary,
        serde_json::to_vec(&value).map_err(|error| format!("encode status: {error}"))?,
    )
    .map_err(|error| format!("write status: {error}"))?;
    publish_status(&temporary, path)
}

#[cfg(windows)]
fn publish_status(temporary: &Path, destination: &Path) -> Result<(), String> {
    let temporary_wide: Vec<u16> = windows_publish_path(temporary)?
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let destination_wide: Vec<u16> = windows_publish_path(destination)?
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let started = Instant::now();
    loop {
        let moved = unsafe {
            MoveFileExW(
                temporary_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING,
            )
        };
        if moved != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        let retryable = matches!(
            error.raw_os_error().map(|code| code as u32),
            Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_UNABLE_TO_REMOVE_REPLACED)
        );
        if !retryable || started.elapsed() >= STATUS_PUBLISH_RETRY_LIMIT {
            return Err(format!("publish status: {error}"));
        }
        thread::sleep(STATUS_PUBLISH_RETRY_DELAY);
    }
}

#[cfg(windows)]
fn windows_publish_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("status path has no parent: {}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("status path has no file name: {}", path.display()))?;
    fs::canonicalize(parent)
        .map(|canonical_parent| canonical_parent.join(file_name))
        .map_err(|error| format!("resolve status parent {}: {error}", parent.display()))
}

#[cfg(not(windows))]
fn publish_status(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination).map_err(|error| format!("publish status: {error}"))
}

fn fail_job(job: &Job, error: &str) -> Result<i32, String> {
    write_status(job, "error", None, Some(error.to_owned()))?;
    Ok(1)
}

fn run_passthrough(real_ffmpeg: &Path, args: &[String]) -> Result<i32, String> {
    Command::new(real_ffmpeg)
        .args(args.iter().map(OsString::from))
        .status()
        .map_err(|error| format!("run real FFmpeg: {error}"))
        .map(|status| status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "ente-jasna-proxy-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    fn job() -> Job {
        Job {
            version: 1,
            job_id: "job".to_owned(),
            input_path: r"C:\input.mp4".to_owned(),
            output_dir: r"C:\output".to_owned(),
            key_info_path: r"C:\output\key-info".to_owned(),
            status_path: r"C:\output\status.json".to_owned(),
            duration_seconds: 10.0,
            source_fps: Some(120.0),
            segment_duration: 2.0,
            min_bitrate: 4_000_000,
            target_bitrate: 6_000_000,
            max_bitrate: 8_000_000,
            max_fps: 60,
        }
    }

    fn args(fps: &str) -> Vec<String> {
        [
            "-y",
            "-i",
            r"C:\input.mp4",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            "1920x1080",
            "-r",
            fps,
            "-i",
            "pipe:0",
            "-map",
            "1:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-tune",
            "ll",
            "-cq",
            "19",
            "-bf",
            "0",
            "-g",
            "240",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "setsar=1/1",
            "-c:a",
            "copy",
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_segment_filename",
            r"C:\jasna\seg_%05d.ts",
            "-hls_list_size",
            "0",
            r"C:\jasna\_hls_internal.m3u8",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    #[test]
    fn rewrites_jasna_stream_to_ente_hls() {
        let result = rewrite_streaming_args(&args("120/1"), &job()).unwrap();
        assert!(has_pair(&result, "-preset", "p7"));
        assert!(has_pair(&result, "-b:v", "6000000"));
        assert!(has_pair(&result, "-minrate", "4000000"));
        assert!(has_pair(&result, "-maxrate", "8000000"));
        assert!(has_pair(&result, "-cq", "17"));
        assert!(has_pair(&result, "-bf", "4"));
        assert!(has_pair(&result, "-spatial-aq", "1"));
        assert!(has_pair(&result, "-aq-strength", "8"));
        assert!(has_pair(&result, "-temporal-aq", "1"));
        assert!(has_pair(&result, "-rc-lookahead", "32"));
        assert!(has_pair(&result, "-g", "120"));
        assert!(has_pair(&result, "-vf", "setsar=1/1,fps=60/1"));
        assert!(has_pair(&result, "-c:a", "aac"));
        assert!(has_pair(&result, "-hls_flags", "single_file"));
        assert_eq!(result.last().unwrap(), r"C:\output\output.m3u8");
    }

    #[test]
    fn preserves_source_fps_below_limit() {
        let mut job = job();
        job.source_fps = Some(60_000.0 / 1_001.0);
        let result = rewrite_streaming_args(&args("60000/1001"), &job).unwrap();
        assert!(has_pair(&result, "-g", "120"));
        assert!(has_pair(&result, "-vf", "setsar=1/1"));
    }

    #[test]
    fn uses_measured_fps_for_variable_frame_rate_input() {
        let mut job = job();
        job.source_fps = Some(25.0);
        let result = rewrite_streaming_args(&args("60/1"), &job).unwrap();
        assert!(has_pair(&result, "-r", "25.000000"));
        assert!(has_pair(&result, "-g", "50"));
        assert!(has_pair(&result, "-vf", "setsar=1/1"));
    }

    #[test]
    fn matches_job_id_embedded_in_jasna_temp_path() {
        let mut selected = job();
        selected.job_id = "a10d7c88-43a3-4c64-8d8a-1ca878b54eb2".to_owned();
        let invocation = vec![
            r"C:\Temp\jasna_hls_a10d7c88-43a3-4c64-8d8a-1ca878b54eb2_x\stream.m3u8".to_owned(),
        ];

        assert!(invocation_mentions_job(&invocation, &selected));
    }

    #[test]
    fn sanitizes_job_id_when_matching_temp_path() {
        let mut selected = job();
        selected.job_id = "job/unsafe".to_owned();
        let invocation = vec![r"C:\Temp\jasna_hls_job_unsafe_x\stream.m3u8".to_owned()];

        assert!(invocation_mentions_job(&invocation, &selected));
    }

    #[test]
    fn replaces_existing_status_file() {
        let directory = temporary_test_directory("status-replace");
        fs::create_dir(&directory).unwrap();
        let status_path = directory.join("status.json");
        let mut selected = job();
        selected.status_path = status_path.to_string_lossy().into_owned();

        write_status(&selected, "running", Some(0.5), None).unwrap();
        write_status(&selected, "complete", Some(1.0), None).unwrap();

        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&status_path).unwrap()).unwrap();
        assert_eq!(value["state"], "complete");
        assert_eq!(value["progress"], 1.0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retries_status_replace_while_a_reader_blocks_delete() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let directory = temporary_test_directory("status-sharing");
        fs::create_dir(&directory).unwrap();
        let status_path = directory.join("status.json");
        let mut selected = job();
        selected.status_path = status_path.to_string_lossy().into_owned();
        write_status(&selected, "running", Some(0.5), None).unwrap();

        let reader = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&status_path)
            .unwrap();
        let release_reader = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            drop(reader);
        });

        write_status(&selected, "complete", Some(1.0), None).unwrap();
        release_reader.join().unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&status_path).unwrap()).unwrap();
        assert_eq!(value["state"], "complete");
        assert_eq!(value["progress"], 1.0);
        assert!(!status_path
            .with_extension(format!("tmp.{}", std::process::id()))
            .exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn bounds_a_permanently_blocked_status_replace() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let directory = temporary_test_directory("status-timeout");
        fs::create_dir(&directory).unwrap();
        let status_path = directory.join("status.json");
        let mut selected = job();
        selected.status_path = status_path.to_string_lossy().into_owned();
        write_status(&selected, "running", Some(0.5), None).unwrap();

        let reader = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&status_path)
            .unwrap();
        let started = Instant::now();
        let error = write_status(&selected, "complete", Some(1.0), None).unwrap_err();

        assert!(started.elapsed() >= STATUS_PUBLISH_RETRY_LIMIT);
        assert!(started.elapsed() < STATUS_PUBLISH_RETRY_LIMIT + Duration::from_secs(1));
        assert!(error.starts_with("publish status:"));
        assert!(status_path
            .with_extension(format!("tmp.{}", std::process::id()))
            .exists());
        drop(reader);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn publishes_status_beyond_the_legacy_windows_path_limit() {
        let root = temporary_test_directory("status-long-path");
        let mut directory = root.clone();
        while directory.as_os_str().len() < 300 {
            directory.push("status-path-segment-0123456789abcdef");
        }
        fs::create_dir_all(&directory).unwrap();
        let status_path = directory.join("status.json");
        let mut selected = job();
        selected.status_path = status_path.to_string_lossy().into_owned();

        write_status(&selected, "running", Some(0.5), None).unwrap();
        write_status(&selected, "complete", Some(1.0), None).unwrap();

        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&status_path).unwrap()).unwrap();
        assert_eq!(value["state"], "complete");
        assert!(status_path.as_os_str().len() > 260);
        fs::remove_dir_all(root).unwrap();
    }
}
