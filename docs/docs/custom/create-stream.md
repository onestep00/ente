---
title: Create Stream Branch
description: Summary of the custom behavior implemented on the create_stream branch
---

# Create Stream Branch

This page summarizes the custom work on the `create_stream` branch from commits authored by `jmg2968@gmail.com`.

## Scope

The branch is not a small patch set. It changes stream generation, playback UX, desktop encoding, web playback integration, and gallery sorting behavior.

High-level themes:

- Desktop-side HLS generation became more hardware-aware
- Mobile-side stream generation and playback became more aggressive and more interactive
- Web/desktop gallery integration was extended to expose stream progress and stream-first playback
- Gallery sorting and layout controls were expanded beyond upstream defaults

## Commit baseline

The branch history from this author is centered on these commits:

- `dfd6868a50` `mod stream`
- `8ace9537b6` `add h264_vaapi`
- `d2e77bb3e0` `add scroll`
- `3b12181bbd` `stream 수정`
- `774a804a81` `fix zoom`
- `0bdc727906` `fix video ratio`
- `35f75ef5d8` `mobile stream to hardware accelerate`
- `da858f2d9e` `mobile encoding`
- `4e633bc6a3` `desktop hardware encoding`
- `4df4890449` `add hardware encoder`
- `3c551ab787` `fix`
- `8943c516b1` `add size sort`
- `73a8883503` `fix sort`

## What is different

### 1. Desktop stream generation is hardware-aware

The desktop worker now tries to use hardware encoders instead of treating HLS generation as software-only.

Key behavior:

- Detects available FFmpeg encoders dynamically
- Prefers `h264_vaapi`, `h264_qsv`, or `h264_nvenc` when available
- Allows explicit overrides through environment variables
- Tracks generation progress and reports it back into the app
- Tunes bitrate, GOP, and FPS ceilings for stream generation

Main files:

- `desktop/src/main/services/ffmpeg-worker.ts`
- `desktop/src/main/services/ffmpeg-progress.ts`
- `desktop/src/main/services/workers.ts`
- `desktop/src/main/stream.ts`

Difference from upstream direction:

- This branch pushes harder on local native encoding capability
- Encoder selection is treated as part of runtime behavior, not just packaging
- Linux-style hardware acceleration support such as `h264_vaapi` was explicitly added

### 2. Mobile stream generation was turned into an active pipeline

The mobile app no longer treats stream generation as a passive side feature. It now owns a more explicit queue, stop logic, retry flow, and recreate logic.

Key behavior:

- Maintains an in-memory and persistent queue for stream work
- Can stop immediately or stop safely based on current FFmpeg progress
- Distinguishes queue intent such as regular generation vs recreate
- Applies bitrate and buffer policies differently for hardware and software paths
- Tries to preserve progress visibility for the UI

Main files:

- `mobile/apps/photos/lib/services/video_preview_service.dart`
- `mobile/apps/photos/lib/services/isolated_ffmpeg_service.dart`
- `mobile/apps/photos/lib/main.dart`
- `mobile/apps/photos/android/gradle.properties`
- `mobile/apps/photos/pubspec.yaml`

Difference from upstream direction:

- This branch favors stream creation as a first-class background workflow
- Queue persistence and cancellation behavior were customized beyond upstream defaults
- Hardware-accelerated generation on mobile was explicitly pursued

### 3. Mobile video playback UX was redesigned around stream switching

Playback changes are not limited to backend generation. The viewer itself was changed so streamed media feels usable in day-to-day interaction.

Key behavior:

- Supports switching between preview stream and original file
- Adds finer seek/scrub behavior
- Improves zoom handling and gesture conflict handling
- Adds fit-mode handling for video ratio issues
- Prevents some scroll-dismiss conflicts during zoom or scrubbing

Main files:

- `mobile/apps/photos/lib/ui/viewer/file/video_widget_native.dart`
- `mobile/apps/photos/lib/ui/viewer/file/video_widget_media_kit_common.dart`
- `mobile/apps/photos/lib/ui/viewer/file/video_fit_mode.dart`
- `mobile/apps/photos/lib/ui/viewer/file/native_video_player_controls/seek_bar.dart`

Difference from upstream direction:

- This branch optimizes for interactive playback ergonomics
- Stream playback and original playback are treated as interchangeable runtime modes
- Gesture conflicts were resolved locally in app code instead of being left to player defaults

### 4. Web and desktop gallery wiring was expanded for stream-first behavior

The web layer was updated so stream generation and playback status can participate in gallery UX.

Key behavior:

- Adds HLS generation status tracking
- Polls generation progress during processing
- Integrates stream status with gallery page behavior
- Extends selected-file actions and related UI so the stream path is easier to reach

Main files:

- `web/packages/gallery/services/video.ts`
- `web/packages/gallery/utils/native-stream.ts`
- `web/apps/photos/src/pages/gallery.tsx`
- `web/packages/new/photos/components/SelectedFileOptions.tsx`

Difference from upstream direction:

- This branch exposes more local processing state in the UI
- HLS generation is treated as an ongoing client-side operation, not just a binary availability check

### 5. Gallery sorting and layout options were expanded

Separate from video streaming, the gallery itself was customized.

Key behavior:

- Added `fileSize` as a collection sort key
- Added explicit home-gallery sort preferences in local settings
- Added a dedicated layout and sorting settings sheet
- Exposed size-based and duration-based sorting options to the UI

Main files:

- `mobile/apps/photos/lib/models/metadata/collection_magic.dart`
- `mobile/apps/photos/lib/utils/local_settings.dart`
- `mobile/apps/photos/lib/ui/viewer/gallery/layout_settings.dart`
- `mobile/apps/photos/lib/ui/viewer/gallery/gallery_app_bar_widget.dart`
- `mobile/apps/photos/lib/db/files_db.dart`

Difference from upstream direction:

- Upstream primarily centers time-based sorting in the home gallery
- This branch turns sort order into a more user-configurable local preference system

## How it was built

The branch was built iteratively rather than in one large rewrite.

Implementation sequence:

1. Stream generation logic was reshaped first, especially in `video_preview_service.dart`
2. Hardware encoding support was then pushed into both desktop and mobile paths
3. Playback UX was adjusted after generation logic matured, especially seek, zoom, and fit-mode behavior
4. Web and desktop surfaces were updated to expose status and stream-first actions
5. Gallery sorting and layout work was added as a parallel customization track

This matters because many files here are coupled:

- encoder choice affects generated output characteristics
- generated output characteristics affect player behavior
- player behavior affects gallery and action-surface expectations

## Custom baseline rules

If this branch is to remain functional while following upstream later, these behaviors should be treated as the custom baseline to preserve:

- Hardware-aware encoder selection on desktop
- Persistent stream-processing queue and safe-stop logic on mobile
- Stream/original switching behavior in the mobile viewer
- Progress-aware HLS status plumbing in web and desktop
- Home gallery sorting by duration and file size

## Merge risk when following upstream

These areas are likely to conflict whenever upstream is merged or rebased in:

- `desktop/package.json`
- `mobile/apps/photos/android/gradle.properties`
- `mobile/apps/photos/lib/main.dart`
- `mobile/apps/photos/pubspec.yaml`
- `mobile/apps/photos/pubspec.lock`
- `web/apps/photos/src/pages/gallery.tsx`
- `web/packages/new/photos/components/SelectedFileOptions.tsx`

These files should be reviewed first in any future upstream follow-up.

## Practical reading order

To understand the branch quickly, read in this order:

1. `mobile/apps/photos/lib/services/video_preview_service.dart`
2. `desktop/src/main/services/ffmpeg-worker.ts`
3. `mobile/apps/photos/lib/ui/viewer/file/video_widget_native.dart`
4. `web/packages/gallery/services/video.ts`
5. `mobile/apps/photos/lib/ui/viewer/gallery/layout_settings.dart`
