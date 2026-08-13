# Jasna stream integration

Ente Desktop can use the unmodified official Jasna Windows NVIDIA release to
restore video previews. Ente starts Jasna's stock persistent streaming mode and
temporarily replaces the release's `tools/ffmpeg.exe` with an Ente proxy. The
proxy delegates non-streaming commands to the bundled FFmpeg and rewrites only
Jasna's raw-frame HLS encoder command.

The integration was verified with the official v0.10.0 release. No Jasna source
patch or custom Jasna build is required.

## Configuration

Extract the Jasna release into a writable directory with an English-only path,
then start Ente Desktop with:

```powershell
$env:ENTE_JASNA_PATH = "C:\path\to\jasna.exe"
yarn dev
```

For an isolated smoke run, set `ENTE_USER_DATA_PATH` before starting Desktop.
Ente applies it before acquiring the single-instance lock, so Chromium state,
keys, and local databases do not use the normal profile.

Optional Jasna model and processing arguments can be supplied as a JSON string
array. Ente adds the persistent stream, port, progress, and logging arguments.

```powershell
$env:ENTE_JASNA_ARGS_JSON = '["--device","cuda:0","--batch-size","4"]'
```

At first use, Ente preserves Jasna's FFmpeg as `tools/ffmpeg.jasna.exe` and
installs its proxy at `tools/ffmpeg.exe`. A small manifest records the installed
proxy hash. If Jasna is updated in place, a changed official FFmpeg replaces the
backup before the current Ente proxy is installed. A fresh Jasna version
directory is handled independently.

## Process and network behavior

- Ente starts one `jasna.exe --stream` process. Jasna creates one pipeline and
  changes `pipeline.input_video` for later `/api/load` calls, so the model
  session remains resident between files.
- A Windows Job Object contains a gated launcher, Jasna, and all descendants.
  Closing the Ente FFmpeg utility process closes the job and terminates the
  complete process tree.
- Ente selects a random free TCP port and calls the API through `127.0.0.1`.
- Jasna v0.10.0 itself binds the server to `0.0.0.0` and provides no host option
  or API authentication. Ente does not patch that upstream behavior. The proxy
  refuses every streaming FFmpeg invocation unless a matching active Ente job
  exists, which prevents an unsolicited `/api/load` request from producing
  Jasna's ordinary plaintext HLS files. The HTTP status and stop endpoints are
  still reachable on networks allowed by the Windows firewall.

## Processing policy

- Jasna sends restored raw frames to FFmpeg over stdin. The source file is also
  opened by FFmpeg for audio. No restored intermediate video is created.
- H.264 is encoded once with NVIDIA NVENC. `multipass=fullres` is NVENC
  rate-control analysis within that encode.
- VBR uses a 10 Mbps floor, targets 15 Mbps, and is capped at 20 Mbps with a
  40 Mbit VBV buffer. The encoder uses preset p6, HQ tuning, CQ 19, temporal AQ,
  three B-frames, B-frame references, and a 20-frame lookahead.
- Source dimensions are preserved. Source FPS is preserved through 60 FPS and
  clamped to 60 above that value. The GOP is one two-second HLS segment.
- Audio is encoded as AAC 192 kbps.
- Jasna's FFmpeg writes AES-128 encrypted, single-file MPEG-TS HLS directly to
  Ente's existing upload workspace. Ente does not run a second encode or remux.
- Existing `vid_preview` objects are replaced only after generation and upload
  succeed. A failed job leaves the previous server preview intact.

## Existing stream migration

Generated playlist metadata records `generator: "jasna-ente-v1"`. When Jasna
is configured, the existing preview backfill queue selects previews with an
absent or older generator and recreates them serially. The migration resumes
across app restarts and does not require a server package change or bulk stream
deletion.

## Temporary input boundary

HLS generation obtains its seekable source through
`SeekableVideoInputProvider`. The current disk provider retains the prior Ente
behavior: downloaded originals and stream inputs are materialized below the
Ente temporary directory and deleted when the lease is released. Local source
paths are used in place.

An encrypted process-isolated provider can replace this implementation without
changing the stream or Jasna call sites. EFS alone is not process isolation:
every process running as the encrypting Windows user can decrypt the file.
ProjFS hydrates projected data into its on-disk virtualization root. A WinFsp
read-only filesystem can serve random reads from encrypted chunk storage and
check the originating PID on open, but it requires the WinFsp kernel driver to
be installed. That driver dependency must be selected and packaged before this
provider becomes the default.
