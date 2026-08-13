import "dart:io";

import "package:dio/dio.dart";
import "package:ente_feature_flag/ente_feature_flag.dart";
import "package:flutter_test/flutter_test.dart";
import "package:mockito/annotations.dart";
import "package:mockito/mockito.dart";
import "package:photos/core/constants.dart";
import "package:photos/db/upload_locks_db.dart";
import "package:photos/module/upload/model/multipart.dart";
import "package:photos/module/upload/service/multipart.dart";

import "multipart_test.mocks.dart";

@GenerateMocks([Dio, UploadLocksDB, FlagService])
void main() {
  late MockDio dio;
  late MockUploadLocksDB db;
  late MockFlagService flags;
  late Directory tempDirectory;

  setUp(() async {
    dio = MockDio();
    db = MockUploadLocksDB();
    flags = MockFlagService();
    tempDirectory = await Directory.systemTemp.createTemp("ente_multipart_");

    when(flags.disableCFWorker).thenReturn(true);
    when(db.updatePartStatus(any, any, any)).thenAnswer((_) async {});
    when(db.updateTrackUploadStatus(any, any)).thenAnswer((_) async {});
  });

  tearDown(() async {
    await tempDirectory.delete(recursive: true);
  });

  test("retries a failed part and sends a full final part", () async {
    final encryptedFile = File("${tempDirectory.path}/encrypted.bin");
    await encryptedFile.open(mode: FileMode.write).then((file) async {
      await file.truncate(multipartPartSize * 2);
      await file.close();
    });

    var putAttempts = 0;
    final sentLengths = <int>[];
    when(
      dio.put<dynamic>(
        any,
        data: anyNamed("data"),
        options: anyNamed("options"),
        onSendProgress: anyNamed("onSendProgress"),
      ),
    ).thenAnswer((invocation) async {
      final options = invocation.namedArguments[#options] as Options;
      sentLengths.add(options.headers![Headers.contentLengthHeader] as int);
      putAttempts++;
      if (putAttempts == 1) {
        throw DioException(
          requestOptions: RequestOptions(path: "part-1"),
          type: DioExceptionType.connectionError,
        );
      }
      return Response<dynamic>(
        requestOptions: RequestOptions(path: "part"),
        headers: Headers.fromMap({
          "etag": ["etag-$putAttempts"],
        }),
      );
    });
    when(
      dio.post<dynamic>(
        any,
        data: anyNamed("data"),
        options: anyNamed("options"),
      ),
    ).thenAnswer(
      (_) async => Response<dynamic>(
        requestOptions: RequestOptions(path: "complete"),
      ),
    );

    final uploader = MultiPartUploader(
      dio,
      dio,
      db,
      flags,
      partRetryDelay: Duration.zero,
    );
    final urls = MultipartUploadURLs(
      objectKey: "object-key",
      partsURLs: ["part-1", "part-2"],
      completeURL: "complete",
    );

    final objectKey = await uploader.putMultipartFile(
      urls,
      encryptedFile,
      multipartPartSize * 2,
    );

    expect(objectKey, "object-key");
    expect(putAttempts, 3);
    expect(sentLengths, [
      multipartPartSize,
      multipartPartSize,
      multipartPartSize,
    ]);
    verify(db.updatePartStatus("object-key", 0, "etag-2")).called(1);
    verify(db.updatePartStatus("object-key", 1, "etag-3")).called(1);
    verify(
      db.updateTrackUploadStatus("object-key", MultipartStatus.completed),
    ).called(1);
  });
}
