import "package:flutter/material.dart";

enum VideoFitMode {
  fitWidth,
  fitHeight,
  full,
}

VideoFitMode nextVideoFitMode(VideoFitMode mode) {
  switch (mode) {
    case VideoFitMode.fitWidth:
      return VideoFitMode.fitHeight;
    case VideoFitMode.fitHeight:
      return VideoFitMode.full;
    case VideoFitMode.full:
      return VideoFitMode.fitWidth;
  }
}

BoxFit videoFitModeToBoxFit(VideoFitMode mode) {
  switch (mode) {
    case VideoFitMode.fitWidth:
      return BoxFit.fitWidth;
    case VideoFitMode.fitHeight:
      return BoxFit.fitHeight;
    case VideoFitMode.full:
      return BoxFit.contain;
  }
}

IconData videoFitModeToIcon(VideoFitMode mode) {
  switch (mode) {
    case VideoFitMode.fitWidth:
      return Icons.width_full;
    case VideoFitMode.fitHeight:
      return Icons.height;
    case VideoFitMode.full:
      return Icons.fullscreen;
  }
}

VideoFitMode autoVideoFitMode({
  required double videoAspectRatio,
  required double viewportAspectRatio,
}) {
  if (videoAspectRatio <= 0 || viewportAspectRatio <= 0) {
    return VideoFitMode.fitWidth;
  }
  if (videoAspectRatio >= viewportAspectRatio) {
    return VideoFitMode.fitWidth;
  }
  return VideoFitMode.fitHeight;
}

class VideoFitModeButton extends StatelessWidget {
  final VideoFitMode mode;
  final VoidCallback onPressed;
  final Color color;
  final double size;
  final double hitArea;

  const VideoFitModeButton({
    super.key,
    required this.mode,
    required this.onPressed,
    required this.color,
    this.size = 18,
    this.hitArea = 28,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onPressed,
      child: SizedBox(
        width: hitArea,
        height: hitArea,
        child: Center(
          child: Icon(
            videoFitModeToIcon(mode),
            size: size,
            color: color,
          ),
        ),
      ),
    );
  }
}
