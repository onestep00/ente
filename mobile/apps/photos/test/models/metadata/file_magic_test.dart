import "package:flutter_test/flutter_test.dart";
import "package:photos/models/metadata/file_magic.dart";

void main() {
  group('stream recreation request metadata', () {
    test('is pending until desktop acknowledges the same token', () {
      final metadata = PubMagicMetadata.fromJson({
        streamRecreateRequestKey: 42,
        streamRecreateAckKey: 41,
      });

      expect(metadata.hasPendingStreamRecreateRequest, isTrue);

      metadata.streamRecreateAck = 42;
      expect(metadata.hasPendingStreamRecreateRequest, isFalse);
    });

    test('ignores duplicate and newer acknowledgements', () {
      final duplicate = PubMagicMetadata.fromJson({
        streamRecreateRequestKey: 42,
        streamRecreateAckKey: 42,
      });
      final newerAck = PubMagicMetadata.fromJson({
        streamRecreateRequestKey: 42,
        streamRecreateAckKey: 43,
      });

      expect(duplicate.hasPendingStreamRecreateRequest, isFalse);
      expect(newerAck.hasPendingStreamRecreateRequest, isFalse);
    });
  });
}
