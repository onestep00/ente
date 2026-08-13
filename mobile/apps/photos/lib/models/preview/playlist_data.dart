import "dart:io";

class PlaylistData {
  File preview;
  int? width;
  int? height;
  int? size;
  int? durationInSeconds;
  String? generator;

  PlaylistData({
    required this.preview,
    this.width,
    this.height,
    this.size,
    this.durationInSeconds,
    this.generator,
  });
}
