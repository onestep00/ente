import "dart:async";
import "package:ffmpeg_kit_flutter/ffmpeg_kit.dart";
import "package:ffmpeg_kit_flutter/ffmpeg_kit_config.dart";
import "package:ffmpeg_kit_flutter/ffmpeg_session.dart";
import "package:ffmpeg_kit_flutter/ffprobe_kit.dart";
import "package:ffmpeg_kit_flutter/statistics.dart";
import "package:photos/service_locator.dart";
import "package:photos/utils/ffprobe_util.dart";

class IsolatedFfmpegService {
  IsolatedFfmpegService._privateConstructor();

  static final IsolatedFfmpegService instance =
      IsolatedFfmpegService._privateConstructor();
  final Map<int, int> _sessionProgressMs = {};

  Future<Map> runFfmpeg(String command) async {
    final session = await FFmpegKit.execute(command);
    final returnCode = await session.getReturnCode();
    final output = await session.getOutput();

    return {
      "returnCode": returnCode?.getValue(),
      "output": output,
    };
  }

  /// Run FFmpeg with session ID callback for cancellation support.
  Future<Map> runFfmpegCancellable(
    String command,
    void Function(int sessionId) onSessionStarted,
  ) async {
    final completer = Completer<Map>();
    try {
      final session = await FFmpegKit.executeAsync(
        command,
        (completedSession) async {
          final returnCode = await completedSession.getReturnCode();
          final output = await completedSession.getOutput();
          final completedSessionId = completedSession.getSessionId();
          if (completedSessionId != null) {
            _sessionProgressMs.remove(completedSessionId);
          }
          if (!completer.isCompleted) {
            completer.complete({
              "returnCode": returnCode?.getValue(),
              "output": output,
            });
          }
        },
        null,
        (statistics) {
          _sessionProgressMs[statistics.getSessionId()] = statistics.getTime();
        },
      );
      final sessionId = session.getSessionId();
      if (sessionId != null) {
        onSessionStarted(sessionId);
      }
    } catch (error, stackTrace) {
      if (!completer.isCompleted) {
        completer.complete({
          "returnCode": null,
          "output": "FFmpeg error: $error\n$stackTrace",
        });
      }
    }

    return completer.future;
  }

  Future<Map> getVideoInfo(String file) async {
    final session = await FFprobeKit.getMediaInformation(file);
    final mediaInfo = session.getMediaInformation();

    if (mediaInfo == null) {
      return {};
    }

    final metadata = await FFProbeUtil.getMetadata(mediaInfo);
    return metadata;
  }

  Future<double?> getSessionProgress({
    required int? sessionId,
    required Duration? duration,
  }) async {
    if (sessionId == null || duration == null) return null;
    if (duration.inMilliseconds <= 0) return null;

    final session = await FFmpegKitConfig.getSession(sessionId);
    if (session == null || session is! FFmpegSession) return null;

    final int? cachedMs = _sessionProgressMs[sessionId];
    double? ms;
    if (cachedMs != null) {
      ms = cachedMs.toDouble();
    } else {
      final stats = await session.getStatistics();
      if (stats.isEmpty) return null;
      ms = stats.last.getTime().toDouble();
    }
    return (ms / duration.inMilliseconds).clamp(0.0, 1.0);
  }
}
