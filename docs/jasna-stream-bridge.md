# Jasna stream integration

Ente Desktop can use the unmodified official Jasna Windows NVIDIA release to
restore video previews. Ente starts Jasna's stock persistent streaming mode and
temporarily replaces the release's `tools/ffmpeg.exe` with an Ente proxy. The
proxy delegates non-streaming commands to the bundled FFmpeg and rewrites only
Jasna's raw-frame HLS encoder command.

The integration was verified with the official v0.10.0 release. No Jasna source
patch or custom Jasna build is required.

The reproducible Windows desktop and Android build commands are documented in
[Windows client builds](windows-client-build.md).

## Managed installation

On Windows x64, Ente installs the verified official Jasna v0.10.0 NVIDIA
release on demand. The first stream job downloads its three release parts,
checks their pinned sizes and SHA-256 hashes, and extracts them into:

```text
%LOCALAPPDATA%\ente\jasna\versions\v0.10.0
```

Downloads resume from `.partial` files. Extraction uses a version-specific
staging directory and `current.json` is written only after `jasna.exe` exists.
The 4.23 GB release archives are removed after installation. The extracted
installation currently requires approximately 8.18 GB.

`ENTE_JASNA_PATH` remains an explicit development and recovery override:

```powershell
$env:ENTE_JASNA_PATH = "C:\path\to\jasna.exe"
yarn dev
```

`ENTE_JASNA_HOME` overrides the managed installation root. Ente does not query
GitHub for the latest version at runtime: the release and hashes remain pinned
until the integration is tested with a newer upstream version.

For an isolated smoke run, set `ENTE_USER_DATA_PATH` before starting Desktop.
Ente applies it before acquiring the single-instance lock, so Chromium state,
keys, and local databases do not use the normal profile.

Optional Jasna model and processing arguments can be supplied as a JSON string
array. Ente adds the persistent stream, port, progress, and logging arguments.

```powershell
$env:ENTE_JASNA_ARGS_JSON = '["--device","cuda:0","--batch-size","4"]'
```

At first processing use, Ente preserves Jasna's FFmpeg as
`tools/ffmpeg.jasna.exe` and installs its proxy at `tools/ffmpeg.exe`. A small
manifest records the installed proxy hash. If Jasna is updated in place, a
changed official FFmpeg replaces the backup before the current Ente proxy is
installed. A fresh Jasna version directory is handled independently.

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
- VBR uses a 4 Mbps floor, targets 6 Mbps, and is capped at 8 Mbps with a
  16 Mbit VBV buffer. The encoder uses preset p7, HQ tuning, CQ 17, spatial and
  temporal AQ, four B-frames, B-frame references, and a 32-frame lookahead.
- Source dimensions are preserved. Source FPS is preserved through 60 FPS and
  clamped to 60 above that value. The GOP is one two-second HLS segment.
- Audio is encoded as AAC 192 kbps.
- Jasna's FFmpeg writes AES-128 encrypted, single-file MPEG-TS HLS directly to
  Ente's existing upload workspace. Ente does not run a second encode or remux.
- Existing `vid_preview` objects are replaced only after generation and upload
  succeed. A failed job leaves the previous server preview intact.

## Existing stream migration

Generated playlist metadata records `generator: "jasna-ente-v4"`. When Jasna
is configured, the existing preview backfill queue selects previews with an
absent or older generator and recreates them serially. The migration resumes
across app restarts and does not require a server package change or bulk stream
deletion.

## Mobile recreation requests

The Android **Recreate stream** action writes a monotonically increasing
`streamRecreateRequest` token into the file's encrypted public magic metadata.
Desktop pulls this metadata, places the matching forced recreation item at the
front of its live queue, and writes `streamRecreateAck` only after the new
stream has uploaded successfully. Repeated taps with an outstanding request do
not create duplicate work. If the acknowledgement write fails after a completed
upload, Desktop retries only the metadata acknowledgement during later syncs;
it does not run Jasna again while that process remains active.

Desktop's Electron main process emits a sync pulse every 60 seconds. The
renderer has background throttling disabled for this window, so the incremental
file pull continues while Ente is hidden in the system tray. Requests are also
checked during startup, the ordinary five-minute full pull, and window-focus
sync. Detection therefore normally takes at most 60 seconds plus the incremental
pull duration while the PC is online. A currently active stream task is allowed
to finish; the requested file is first among the remaining queued items.

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
