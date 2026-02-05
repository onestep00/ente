import "dart:async";

import "package:ente_pure_utils/ente_pure_utils.dart";
import "package:flutter/material.dart";
import "package:media_kit_video/media_kit_video.dart";
import "package:photos/models/file/file.dart";
import "package:photos/states/detail_page_state.dart";
import "package:photos/theme/colors.dart";
import "package:photos/theme/ente_theme.dart";
import "package:photos/ui/actions/file/file_actions.dart";
import "package:photos/ui/common/loading_widget.dart";
import "package:photos/ui/viewer/file/video_fit_mode.dart";
import "package:photos/ui/viewer/file/video_stream_change.dart";
import "package:photos/ui/viewer/file/zoomable_video_viewer.dart";

class VideoWidget extends StatefulWidget {
  final EnteFile file;
  final VideoController controller;
  final FullScreenRequestCallback? playbackCallback;
  final TransformationController? transformationController;
  final Function(bool)? shouldDisableScroll;
  final bool isFromMemories;
  final void Function() onStreamChange;
  final bool isPreviewPlayer;

  const VideoWidget(
    this.file,
    this.controller,
    this.playbackCallback, {
    super.key,
    this.transformationController,
    this.shouldDisableScroll,
    required this.isFromMemories,
    // ignore: unused_element
    required this.onStreamChange,
    required this.isPreviewPlayer,
  });

  @override
  State<VideoWidget> createState() => _VideoWidgetState();
}

class _VideoWidgetState extends State<VideoWidget> {
  final showControlsNotifier = ValueNotifier<bool>(true);
  static const double verticalMargin = 64;
  final _hideControlsDebouncer = Debouncer(
    const Duration(milliseconds: 2000),
  );
  final _isSeekingNotifier = ValueNotifier<bool>(false);
  final _scrubProgressNotifier = ValueNotifier<double?>(null);
  final _scrubDebouncer = Debouncer(
    const Duration(milliseconds: 50),
    executionInterval: const Duration(milliseconds: 50),
  );
  late final StreamSubscription<bool> _isPlayingStreamSubscription;
  bool _isScrubbing = false;
  double _scrubSecondsPerPixel = 0;
  int _scrubTargetMs = 0;
  int _scrubDurationMs = 0;
  final Map<int, Offset> _activePointers = {};
  bool _isPinching = false;
  VideoFitMode? _fitModeOverride;
  int? _videoWidth;
  int? _videoHeight;
  StreamSubscription<int?>? _videoWidthSubscription;
  StreamSubscription<int?>? _videoHeightSubscription;

  @override
  void initState() {
    super.initState();
    _isPlayingStreamSubscription =
        widget.controller.player.stream.playing.listen((isPlaying) {
      if (isPlaying && !_isSeekingNotifier.value) {
        _hideControlsDebouncer.run(() async {
          showControlsNotifier.value = false;
          widget.playbackCallback?.call(
            true,
            FullScreenRequestReason.playbackStateChange,
          );
        });
      }
    });

    _isSeekingNotifier.addListener(isSeekingListener);
    _videoWidth = widget.controller.player.state.width;
    _videoHeight = widget.controller.player.state.height;
    _videoWidthSubscription =
        widget.controller.player.stream.width.listen((value) {
      if (_videoWidth == value) return;
      _videoWidth = value;
      if (!mounted || _fitModeOverride != null) return;
      setState(() {});
    });
    _videoHeightSubscription =
        widget.controller.player.stream.height.listen((value) {
      if (_videoHeight == value) return;
      _videoHeight = value;
      if (!mounted || _fitModeOverride != null) return;
      setState(() {});
    });
  }

  @override
  void dispose() {
    showControlsNotifier.dispose();
    _isPlayingStreamSubscription.cancel();
    _hideControlsDebouncer.cancelDebounceTimer();
    _isSeekingNotifier.removeListener(isSeekingListener);
    _isSeekingNotifier.dispose();
    _scrubProgressNotifier.dispose();
    _scrubDebouncer.cancelDebounceTimer();
    _videoWidthSubscription?.cancel();
    _videoHeightSubscription?.cancel();
    super.dispose();
  }

  void isSeekingListener() {
    if (_isSeekingNotifier.value) {
      _hideControlsDebouncer.cancelDebounceTimer();
    } else {
      if (widget.controller.player.state.playing) {
        _hideControlsDebouncer.run(() async {
          showControlsNotifier.value = false;
          widget.playbackCallback?.call(
            true,
            FullScreenRequestReason.playbackStateChange,
          );
        });
      }
    }
  }

  int? _videoDurationMs() {
    final controllerDuration =
        widget.controller.player.state.duration.inMilliseconds;
    if (controllerDuration > 0) return controllerDuration;
    final fileDuration = widget.file.duration;
    if (fileDuration != null && fileDuration > 0) {
      return fileDuration * 1000;
    }
    return null;
  }

  double _secondsPerPixel(int durationMs) {
    final width = MediaQuery.sizeOf(context).width;
    if (width <= 0) return 0;
    final secondsPerPixel = durationMs / 1000 / width;
    const minSecondsPerPixel = 0.05;
    const maxSecondsPerPixel = 2.0;
    if (secondsPerPixel < minSecondsPerPixel) return minSecondsPerPixel;
    if (secondsPerPixel > maxSecondsPerPixel) return maxSecondsPerPixel;
    return secondsPerPixel;
  }

  VideoFitMode _currentFitMode(BuildContext context) {
    final override = _fitModeOverride;
    if (override != null) return override;
    final aspectRatio = _videoAspectRatio();
    final viewport = MediaQuery.sizeOf(context);
    if (aspectRatio == null || viewport.width <= 0 || viewport.height <= 0) {
      return VideoFitMode.fitWidth;
    }
    return autoVideoFitMode(
      videoAspectRatio: aspectRatio,
      viewportAspectRatio: viewport.width / viewport.height,
    );
  }

  double? _videoAspectRatio() {
    final width = _videoWidth ?? widget.controller.player.state.width;
    final height = _videoHeight ?? widget.controller.player.state.height;
    if (width == null || height == null || width <= 0 || height <= 0) {
      return null;
    }
    return width / height;
  }

  void _toggleFitMode(VideoFitMode currentMode) {
    setState(() {
      _fitModeOverride = nextVideoFitMode(currentMode);
      _resetZoom();
    });
  }

  void _resetZoom() {
    widget.transformationController?.value = Matrix4.identity();
    _isPinching = false;
    _activePointers.clear();
  }

  void _handlePointerDown(PointerDownEvent event) {
    _activePointers[event.pointer] = event.position;
    if (_activePointers.length == 2) {
      if (_isScrubbing) {
        _onScrubCancel();
      }
      _isPinching = true;
      _hideControlsDebouncer.cancelDebounceTimer();
      showControlsNotifier.value = true;
    }
  }

  void _handlePointerMove(PointerMoveEvent event) {
    if (!_activePointers.containsKey(event.pointer)) return;
    _activePointers[event.pointer] = event.position;
  }

  void _handlePointerEnd(PointerEvent event) {
    _activePointers.remove(event.pointer);
    if (_activePointers.length < 2) {
      _isPinching = false;
    }
  }

  void _onScrubStart(DragStartDetails _) {
    if (_isPinching) return;
    final durationMs = _videoDurationMs();
    if (durationMs == null || durationMs <= 0) return;
    _scrubDurationMs = durationMs;
    _scrubSecondsPerPixel = _secondsPerPixel(durationMs);
    _scrubTargetMs =
        widget.controller.player.state.position.inMilliseconds;
    _scrubTargetMs = _scrubTargetMs.clamp(0, _scrubDurationMs) as int;
    _isScrubbing = true;
    _isSeekingNotifier.value = true;
    showControlsNotifier.value = true;
    _scrubProgressNotifier.value = _scrubTargetMs / _scrubDurationMs;
  }

  void _onScrubUpdate(DragUpdateDetails details) {
    if (_isPinching) return;
    if (!_isScrubbing || _scrubDurationMs <= 0) return;
    if (_scrubSecondsPerPixel == 0) return;
    final deltaSeconds = details.delta.dx * _scrubSecondsPerPixel;
    if (deltaSeconds == 0) return;
    _scrubTargetMs += (deltaSeconds * 1000).round();
    _scrubTargetMs = _scrubTargetMs.clamp(0, _scrubDurationMs) as int;
    _seekToScrubTarget();
  }

  void _onScrubEnd(DragEndDetails _) {
    if (_isPinching) return;
    if (!_isScrubbing) return;
    _isScrubbing = false;
    _seekToScrubTarget();
    _scrubProgressNotifier.value = null;
    _isSeekingNotifier.value = false;
  }

  void _onScrubCancel() {
    _isScrubbing = false;
    _scrubProgressNotifier.value = null;
    _isSeekingNotifier.value = false;
  }

  void _seekToScrubTarget() {
    if (_scrubDurationMs <= 0) return;
    _scrubProgressNotifier.value = _scrubTargetMs / _scrubDurationMs;
    _scrubDebouncer.run(() async {
      await widget.controller.player.seek(
        Duration(milliseconds: _scrubTargetMs),
      );
    });
  }

  Widget _buildScrubOverlay() {
    return ValueListenableBuilder<double?>(
      valueListenable: _scrubProgressNotifier,
      builder: (context, scrubValue, _) {
        if (scrubValue == null) {
          return const SizedBox.shrink();
        }
        final scrubSeconds = (_scrubTargetMs / 1000).floor();
        return Positioned.fill(
          child: IgnorePointer(
            child: Center(
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.6),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: strokeFaintDark,
                    width: 1,
                  ),
                ),
                child: Text(
                  secondsToDuration(scrubSeconds),
                  style: getEnteTextTheme(context).h3Bold.copyWith(
                        color: textBaseDark,
                      ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final fitMode = _currentFitMode(context);
    final videoWidget = Video(
      controller: widget.controller,
      fit: videoFitModeToBoxFit(fitMode),
      controls: NoVideoControls,
    );
    final videoLayer = widget.transformationController != null
        ? ZoomableVideoViewer(
            transformationController: widget.transformationController!,
            shouldDisableScroll: widget.shouldDisableScroll,
            child: videoWidget,
          )
        : videoWidget;

    return Stack(
      fit: StackFit.expand,
      children: [
        ClipRect(child: videoLayer),
        ValueListenableBuilder(
          valueListenable: showControlsNotifier,
          builder: (context, value, _) {
            final enableScrub = !widget.isFromMemories;
            return AnimatedOpacity(
              duration: const Duration(milliseconds: 200),
              opacity: value ? 1 : 0,
              curve: Curves.easeInOutQuad,
              child: Listener(
                behavior: HitTestBehavior.translucent,
                onPointerDown: _handlePointerDown,
                onPointerMove: _handlePointerMove,
                onPointerUp: _handlePointerEnd,
                onPointerCancel: _handlePointerEnd,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    GestureDetector(
                      behavior: HitTestBehavior.translucent,
                      onTap: widget.isFromMemories
                          ? null
                          : () {
                              showControlsNotifier.value =
                                  !showControlsNotifier.value;
                              if (widget.playbackCallback != null) {
                                widget.playbackCallback!(
                                  !showControlsNotifier.value,
                                  FullScreenRequestReason.userInteraction,
                                );
                              }
                            },
                      onHorizontalDragStart:
                          enableScrub ? _onScrubStart : null,
                      onHorizontalDragUpdate:
                          enableScrub ? _onScrubUpdate : null,
                      onHorizontalDragEnd: enableScrub ? _onScrubEnd : null,
                      onHorizontalDragCancel:
                          enableScrub ? _onScrubCancel : null,
                      onLongPress: () {
                        if (widget.isFromMemories) {
                          widget.playbackCallback?.call(
                            false,
                            FullScreenRequestReason.userInteraction,
                          );
                          if (widget.controller.player.state.playing) {
                            widget.controller.player.pause();
                          }
                        }
                      },
                      onLongPressUp: () {
                        if (widget.isFromMemories) {
                          widget.playbackCallback?.call(
                            true,
                            FullScreenRequestReason.userInteraction,
                          );
                          if (!widget.controller.player.state.playing) {
                            widget.controller.player.play();
                          }
                        }
                      },
                      child: Container(
                        constraints: const BoxConstraints.expand(),
                      ),
                    ),
                    widget.isFromMemories
                        ? const SizedBox.shrink()
                        : IgnorePointer(
                            ignoring: !value,
                            child: PlayPauseButtonMediaKit(widget.controller),
                          ),
                    _buildScrubOverlay(),
                    widget.isFromMemories
                        ? const SizedBox.shrink()
                        : Positioned(
                            bottom: verticalMargin,
                            right: 0,
                            left: 0,
                            child: IgnorePointer(
                              ignoring: !value,
                              child: SafeArea(
                                top: false,
                                left: false,
                                right: false,
                                child: Padding(
                                  padding: EdgeInsets.only(
                                    bottom: widget.isFromMemories ? 32 : 0,
                                  ),
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      VideoStreamChangeWidget(
                                        showControls: value,
                                        file: widget.file,
                                        isPreviewPlayer: widget.isPreviewPlayer,
                                        onStreamChange: widget.onStreamChange,
                                      ),
                                      SeekBarAndDuration(
                                        controller: widget.controller,
                                        isSeekingNotifier: _isSeekingNotifier,
                                        file: widget.file,
                                        scrubPositionNotifier:
                                            _scrubProgressNotifier,
                                        fitMode: fitMode,
                                        onToggleFitMode: () =>
                                            _toggleFitMode(fitMode),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                  ],
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

class PlayPauseButtonMediaKit extends StatefulWidget {
  final VideoController? controller;
  const PlayPauseButtonMediaKit(
    this.controller, {
    super.key,
  });

  @override
  State<PlayPauseButtonMediaKit> createState() => _PlayPauseButtonState();
}

class _PlayPauseButtonState extends State<PlayPauseButtonMediaKit> {
  bool _isPlaying = true;
  late final StreamSubscription<bool>? isPlayingStreamSubscription;
  late StreamSubscription<bool>? _bufferStateSubscription;
  late var buffering = widget.controller?.player.state.buffering ?? true;

  @override
  void initState() {
    super.initState();

    isPlayingStreamSubscription =
        widget.controller?.player.stream.playing.listen((isPlaying) {
      setState(() {
        _isPlaying = isPlaying;
      });
    });

    _bufferStateSubscription =
        widget.controller?.player.stream.buffering.listen(
      (event) => setState(() => buffering = event),
    );
  }

  @override
  void dispose() {
    isPlayingStreamSubscription?.cancel();
    _bufferStateSubscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (buffering) return const EnteLoadingWidget();

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () {
        if (widget.controller?.player.state.playing ?? false) {
          widget.controller?.player.pause();
        } else {
          widget.controller?.player.play();
        }
      },
      child: Container(
        width: 54,
        height: 54,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.3),
          shape: BoxShape.circle,
          border: Border.all(
            color: strokeFaintDark,
            width: 1,
          ),
        ),
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (Widget child, Animation<double> animation) {
            return ScaleTransition(scale: animation, child: child);
          },
          switchInCurve: Curves.easeInOutQuart,
          switchOutCurve: Curves.easeInOutQuart,
          child: _isPlaying
              ? const Icon(
                  Icons.pause,
                  size: 32,
                  key: ValueKey("pause"),
                  color: Colors.white,
                )
              : const Icon(
                  Icons.play_arrow,
                  size: 36,
                  key: ValueKey("play"),
                  color: Colors.white,
                ),
        ),
      ),
    );
  }
}

class SeekBarAndDuration extends StatelessWidget {
  final VideoController? controller;
  final ValueNotifier<bool> isSeekingNotifier;
  final EnteFile file;
  final ValueNotifier<double?>? scrubPositionNotifier;
  final VideoFitMode fitMode;
  final VoidCallback onToggleFitMode;

  const SeekBarAndDuration({
    super.key,
    required this.controller,
    required this.isSeekingNotifier,
    required this.file,
    this.scrubPositionNotifier,
    required this.fitMode,
    required this.onToggleFitMode,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: 8,
      ),
      child: Container(
        padding: const EdgeInsets.fromLTRB(
          16,
          4,
          16,
          4,
        ),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.3),
          borderRadius: const BorderRadius.all(
            Radius.circular(8),
          ),
          border: Border.all(
            color: strokeFaintDark,
            width: 1,
          ),
        ),
        child: Column(
          children: [
            file.caption != null && file.caption!.isNotEmpty
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(
                      0,
                      8,
                      0,
                      12,
                    ),
                    child: GestureDetector(
                      onTap: () {
                        showDetailsSheet(context, file);
                      },
                      child: Text(
                        file.caption!,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: getEnteTextTheme(context)
                            .mini
                            .copyWith(color: textBaseDark),
                      ),
                    ),
                  )
                : const SizedBox.shrink(),
            Row(
              children: [
                StreamBuilder(
                  stream: controller?.player.stream.position,
                  builder: (context, snapshot) {
                    if (snapshot.data == null) {
                      return Text(
                        "0:00",
                        style: getEnteTextTheme(
                          context,
                        ).mini.copyWith(
                              color: textBaseDark,
                            ),
                      );
                    }
                    return Text(
                      secondsToDuration(snapshot.data!.inSeconds),
                      style: getEnteTextTheme(
                        context,
                      ).mini.copyWith(
                            color: textBaseDark,
                          ),
                    );
                  },
                ),
                Expanded(
                  child: SeekBar(
                    controller!,
                    isSeekingNotifier,
                    scrubPositionNotifier: scrubPositionNotifier,
                  ),
                ),
                Text(
                  _secondsToDuration(
                    controller!.player.state.duration.inSeconds,
                  ),
                  style: getEnteTextTheme(
                    context,
                  ).mini.copyWith(
                        color: textBaseDark,
                      ),
                ),
                const SizedBox(width: 4),
                VideoFitModeButton(
                  mode: fitMode,
                  onPressed: onToggleFitMode,
                  color: textBaseDark,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Returns the duration in the format "h:mm:ss" or "m:ss".
  String _secondsToDuration(int totalSeconds) {
    final hours = totalSeconds ~/ 3600;
    final minutes = (totalSeconds % 3600) ~/ 60;
    final seconds = totalSeconds % 60;

    if (hours > 0) {
      return '${hours.toString().padLeft(1, '0')}:${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
    } else {
      return '${minutes.toString().padLeft(1, '0')}:${seconds.toString().padLeft(2, '0')}';
    }
  }
}

class SeekBar extends StatefulWidget {
  final VideoController controller;
  final ValueNotifier<bool> isSeekingNotifier;
  final ValueNotifier<double?>? scrubPositionNotifier;
  const SeekBar(
    this.controller,
    this.isSeekingNotifier, {
    super.key,
    this.scrubPositionNotifier,
  });

  @override
  State<SeekBar> createState() => _SeekBarState();
}

class _SeekBarState extends State<SeekBar> {
  double _sliderValue = 0.0;
  late final StreamSubscription<Duration> _positionStreamSubscription;
  VoidCallback? _scrubListener;
  final _debouncer = Debouncer(
    const Duration(milliseconds: 300),
    executionInterval: const Duration(milliseconds: 300),
  );
  @override
  void initState() {
    super.initState();
    _positionStreamSubscription =
        widget.controller.player.stream.position.listen((event) {
      if (widget.isSeekingNotifier.value) return;
      if (mounted) {
        setState(() {
          _sliderValue = (event.inMilliseconds /
                  widget.controller.player.state.duration.inMilliseconds)
              .clamp(0, 1);
          if (_sliderValue.isNaN) {
            _sliderValue = 0.0;
          }
        });
      }
    });
    if (widget.scrubPositionNotifier != null) {
      _scrubListener = () {
        final value = widget.scrubPositionNotifier!.value;
        if (value == null) return;
        if (mounted) {
          setState(() {
            _sliderValue = value.clamp(0, 1);
            if (_sliderValue.isNaN) {
              _sliderValue = 0.0;
            }
          });
        }
      };
      widget.scrubPositionNotifier!.addListener(_scrubListener!);
    }
  }

  @override
  void dispose() {
    _positionStreamSubscription.cancel();
    if (_scrubListener != null) {
      widget.scrubPositionNotifier?.removeListener(_scrubListener!);
    }
    _debouncer.cancelDebounceTimer();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SliderTheme(
      data: SliderTheme.of(context).copyWith(
        trackHeight: 1.0,
        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8.0),
        overlayShape: const RoundSliderOverlayShape(overlayRadius: 14.0),
        activeTrackColor: backgroundElevatedLight,
        inactiveTrackColor: fillMutedDark,
        thumbColor: backgroundElevatedLight,
        overlayColor: fillMutedDark,
      ),
      child: Slider(
        min: 0.0,
        max: 1.0,
        value: _sliderValue,
        onChangeStart: (value) {
          if (mounted) {
            setState(() {
              widget.isSeekingNotifier.value = true;
            });
          }
        },
        onChanged: (value) {
          if (mounted) {
            setState(() {
              _sliderValue = value;
            });
          }

          _debouncer.run(() async {
            await widget.controller.player.seek(
              Duration(
                milliseconds: (value *
                        widget.controller.player.state.duration.inMilliseconds)
                    .round(),
              ),
            );
          });
        },
        divisions: 4500,
        onChangeEnd: (value) async {
          await widget.controller.player.seek(
            Duration(
              milliseconds: (value *
                      widget.controller.player.state.duration.inMilliseconds)
                  .round(),
            ),
          );
          if (mounted) {
            setState(() {
              widget.isSeekingNotifier.value = false;
            });
          }
        },
        allowedInteraction: SliderInteraction.tapAndSlide,
      ),
    );
  }
}
