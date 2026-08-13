# Jasna stream integration checklist

## Safety and scope

- [x] Work in an isolated `codex/jasna-streams` worktree.
- [x] Preserve original encrypted files and file keys.
- [x] Keep all server packages unchanged.
- [x] Replace each generated preview only after upload succeeds.
- [x] Auto-install the pinned Jasna release when the first stream job needs it.
- [x] Resume multipart downloads and verify pinned sizes and SHA-256 hashes.
- [x] Remove release archives after a successful managed installation.
- [x] Use the unmodified official Jasna release.

## Jasna process architecture

- [x] Verify the official v0.10.0 CLI and source implementation.
- [x] Use stock `--stream` and `/api/load` instead of a Jasna source patch.
- [x] Keep one Jasna process and one pipeline/model session across queue items.
- [x] Feed restored frames directly to one FFmpeg process over a bounded pipe.
- [x] Inject the Ente encoder policy only into raw-frame HLS invocations.
- [x] Reject streaming FFmpeg calls without a matching active Ente job.
- [x] Serialize jobs and emit structured progress and errors.
- [x] Put the gated launcher and complete Jasna process tree in a Windows Job
      Object with kill-on-close.
- [x] Record Jasna's fixed `0.0.0.0` bind and remaining status/stop exposure.

## Encoding and HLS

- [x] Encode restored video exactly once.
- [x] Use NVIDIA NVENC p6/HQ/full-resolution multipass and deterministic GOPs.
- [x] Preserve source FPS up to a 60 FPS ceiling.
- [x] Preserve source dimensions.
- [x] Use 10/15/20 Mbps minimum/target/maximum VBR.
- [x] Encode audio as AAC 192 kbps.
- [x] Generate AES-128 encrypted single-file MPEG-TS HLS directly from Jasna.
- [x] Remove FFmpeg's unreferenced `output.ts.tmp` artifact.
- [x] Upload through the existing Ente preview path.

## Temporary input abstraction

- [x] Put seekable input acquisition behind `SeekableVideoInputProvider`.
- [x] Preserve existing cleanup behavior in the disk provider.
- [x] Verify that EFS and ProjFS do not provide process-isolated plaintext views.
- [x] Identify WinFsp as the viable encrypted, PID-gated filesystem foundation.
- [ ] Decide whether to require and package the WinFsp kernel driver.
- [ ] Implement and select the encrypted WinFsp provider.

## Bulk replacement

- [x] Verify preview replacement behavior without server changes.
- [x] Migrate owned previews without a destructive reset.
- [x] Download the encrypted original when no unchanged local source exists.
- [x] Commit a processed marker only after restored preview upload succeeds.
- [x] Make retries idempotent and resumable.
- [x] Record the encoding profile version in encrypted preview metadata.

## Verification

- [x] Unit-test FFmpeg FPS, bitrate, GOP, codec, and HLS argument rewriting.
- [x] Test launcher exit-code relay and blocked startup before Job assignment.
- [x] Type-check the Desktop package.
- [x] Build the native proxy through the Desktop build hook.
- [x] Build the production Photos renderer and Windows x64 unpacked package.
- [x] Run the packaged Desktop with an isolated user-data directory.
- [x] Generate and upload encrypted HLS through the packaged stream protocol.
- [x] Start the latest official Windows NVIDIA release and verify bundled models.
- [x] Process two videos in one Jasna PID to verify session reuse.
- [x] Terminate packaged Ente and verify its Jasna process tree exits.
- [x] Test actual 24, 30, 59.94, 60, and 120 FPS inputs.
- [x] Verify 120 FPS clamps to 60 and fractional 59.94 FPS remains fractional.
- [x] Verify AES-encrypted HLS playback metadata with FFprobe.
- [x] Verify no restored intermediate or Jasna segment files are created.
- [x] Verify temporary test inputs and outputs are removed after testing.
- [ ] Test 720p, 4K, and HDR inputs (1080p SDR verified).
- [ ] Add automated Desktop tests for worker restart and migration refill.
- [x] Complete final diff review and commit organization.
