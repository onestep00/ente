import "package:photos/models/file/file.dart";
import "package:photos/models/metadata/file_magic.dart";
import "package:photos/services/file_magic_service.dart";

/// Sends stream recreation requests to a synced desktop Photos client.
class DesktopStreamRecreateService {
  DesktopStreamRecreateService._();

  static final instance = DesktopStreamRecreateService._();

  /// Returns false when an unacknowledged request already exists.
  Future<bool> request(EnteFile file) async {
    if (file.uploadedFileID == null) return false;

    final metadata = file.pubMagicMetadata;
    if (metadata?.hasPendingStreamRecreateRequest ?? false) return false;

    final previous = metadata?.streamRecreateRequest ?? 0;
    final acknowledged = metadata?.streamRecreateAck ?? 0;
    final now = DateTime.now().microsecondsSinceEpoch;
    final request =
        [now, previous + 1, acknowledged + 1].reduce((a, b) => a > b ? a : b);

    // FileMagicService updates the in-memory file before the network request.
    // Restore it when the request fails so a later tap can retry.
    final previousEncodedMetadata = file.pubMmdEncodedJson;
    final previousMetadata = file.pubMagicMetadata;
    final previousMetadataVersion = file.pubMmdVersion;
    try {
      await FileMagicService.instance.updatePublicMagicMetadata(
        [file],
        {streamRecreateRequestKey: request},
      );
    } catch (_) {
      file.pubMmdEncodedJson = previousEncodedMetadata;
      file.pubMagicMetadata = previousMetadata;
      file.pubMmdVersion = previousMetadataVersion;
      rethrow;
    }
    return true;
  }
}
