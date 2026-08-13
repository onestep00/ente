use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const JOB_ENV: &str = "ENTE_JASNA_FFMPEG_JOB";
const REAL_FFMPEG_ENV: &str = "ENTE_JASNA_REAL_FFMPEG";

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
    let Some(job_path) = env::var_os(JOB_ENV) else {
        return run_passthrough(&real_ffmpeg, &args);
    };
    let job_path = PathBuf::from(job_path);
    if !job_path.is_file() {
        if is_streaming_invocation(&args) {
            return Err("refusing Jasna streaming without an active Ente job".to_owned());
        }
        return run_passthrough(&real_ffmpeg, &args);
    }

    let job: Job =
        serde_json::from_slice(&fs::read(&job_path).map_err(|error| format!("read job: {error}"))?)
            .map_err(|error| format!("parse job: {error}"))?;
    validate_job(&job)?;

    if !is_streaming_invocation(&args) {
        return run_passthrough(&real_ffmpeg, &args);
    }
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
    if args.first().map_or(true, |arg| arg != "--") || args.len() < 2 {
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
    let source_fps = input_rate(args, pipe_input)?;
    let output_fps = source_fps.min(job.max_fps as f64);
    let gop = (output_fps * job.segment_duration).round().max(1.0) as u64;

    let mut rewritten = args[..=pipe_input].to_vec();
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
        ("-preset", "p6".to_owned()),
        ("-tune", "hq".to_owned()),
        ("-multipass", "fullres".to_owned()),
        ("-rc", "vbr".to_owned()),
        ("-b:v", job.target_bitrate.to_string()),
        ("-minrate", job.min_bitrate.to_string()),
        ("-maxrate", job.max_bitrate.to_string()),
        ("-bufsize", (job.max_bitrate * 2).to_string()),
        ("-cq", "19".to_owned()),
        ("-bf", "3".to_owned()),
        ("-b_ref_mode", "middle".to_owned()),
        ("-profile:v", "high".to_owned()),
        ("-temporal-aq", "1".to_owned()),
        ("-rc-lookahead", "20".to_owned()),
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
    let _ = fs::remove_file(path);
    fs::rename(&temporary, path).map_err(|error| format!("publish status: {error}"))
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

    fn job() -> Job {
        Job {
            version: 1,
            job_id: "job".to_owned(),
            input_path: r"C:\input.mp4".to_owned(),
            output_dir: r"C:\output".to_owned(),
            key_info_path: r"C:\output\key-info".to_owned(),
            status_path: r"C:\output\status.json".to_owned(),
            duration_seconds: 10.0,
            segment_duration: 2.0,
            min_bitrate: 10_000_000,
            target_bitrate: 15_000_000,
            max_bitrate: 20_000_000,
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
        assert!(has_pair(&result, "-preset", "p6"));
        assert!(has_pair(&result, "-b:v", "15000000"));
        assert!(has_pair(&result, "-minrate", "10000000"));
        assert!(has_pair(&result, "-maxrate", "20000000"));
        assert!(has_pair(&result, "-g", "120"));
        assert!(has_pair(&result, "-vf", "setsar=1/1,fps=60/1"));
        assert!(has_pair(&result, "-c:a", "aac"));
        assert!(has_pair(&result, "-hls_flags", "single_file"));
        assert_eq!(result.last().unwrap(), r"C:\output\output.m3u8");
    }

    #[test]
    fn preserves_source_fps_below_limit() {
        let result = rewrite_streaming_args(&args("60000/1001"), &job()).unwrap();
        assert!(has_pair(&result, "-g", "120"));
        assert!(has_pair(&result, "-vf", "setsar=1/1"));
    }
}
