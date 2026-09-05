import { ensureLocalUser } from "ente-accounts/services/user";
import { isDesktop } from "ente-base/app";
import { assertionFailed } from "ente-base/assert";
import { decryptBlobBytes, encryptBlob } from "ente-base/crypto";
import type { EncryptedBlob } from "ente-base/crypto/types";
import { ensureElectron } from "ente-base/electron";
import { isHTTP4xxError, type PublicAlbumsCredentials } from "ente-base/http";
import { getKV, getKVB, getKVN, setKV } from "ente-base/kv";
import log from "ente-base/log";
import { apiURL } from "ente-base/origins";
import type { PublicMemoryCredentials } from "ente-base/public-memory";
import { ensureAuthToken } from "ente-base/token";
import { uniqueFilesByID } from "ente-gallery/utils/file";
import { fileLogID, type EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { updateFilePublicMagicMetadata } from "ente-new/photos/services/file";
import { savedCollectionFiles } from "ente-new/photos/services/photos-fdb";
import { savedTrashItemFileIDs } from "ente-new/photos/services/trash";
import { gunzip, gzip } from "ente-new/photos/utils/gzip";
import { randomSample } from "ente-utils/array";
import { ensurePrecondition } from "ente-utils/ensure";
import { wait } from "ente-utils/promise";
import {
    initiateGenerateHLS,
    JasnaUnavailableError,
    readGenerateHLSProgress,
    readJasnaStreamProcessingStatus,
    readVideoStream,
    SourcePreparationError,
    videoStreamDone,
    type GenerateHLSResult,
} from "../utils/native-stream";
import { downloadManager, isNetworkDownloadError } from "./download";
import {
    fetchFileData,
    fetchFilePreviewData,
    fetchFilesData,
    putVideoData,
    syncUpdatedFileDataFileIDs,
} from "./file-data";
import {
    fileSystemUploadItemIfUnchanged,
    type ProcessableUploadItem,
    type TimestampedFileSystemUploadItem,
} from "./upload";
import {
    collectCandidatesInBatches,
    excludeFilesByID,
    mapWithConcurrency,
    PlaylistJSON,
    shouldRecreateInvalidPlaylistForJasnaMigration,
    TransientRetryTracker,
    type PlaylistJSON as PlaylistJSONType,
} from "./video-queue";

export type HLSGenerationEnabledStatus = "processing" | "idle";

export type HLSGenerationStatus =
    | { enabled: false }
    | {
          enabled: true;
          status?: HLSGenerationEnabledStatus;
          processedCount?: number;
          totalCount?: number;
          currentProgress?: number;
      };

interface VideoProcessingQueueItem {
    /**
     * The {@link EnteFile} (guaranteed to be of {@link FileType.video}) whose
     * video data needs processing.
     */
    file: EnteFile;
    /**
     * The {@link TimestampedFileSystemUploadItem} when available for the newly
     * uploaded {@link file}.
     *
     * It will be present when this queue item was enqueued during a upload from
     * the current client. If present, this serves as an optimization allowing
     * us to directly read the file off the user's file system.
     */
    timestampedUploadItem?: TimestampedFileSystemUploadItem;
    /**
     * If `true`, recreate the stream even if one already exists.
     */
    forceRecreate?: boolean;
    /** Process before other queued live uploads and backfill items. */
    priority?: boolean;
    /** Synced mobile request to acknowledge after successful recreation. */
    remoteRecreateRequest?: number;
}

const idleWaitInitial = 10 * 1000; /* 10 sec */
const idleWaitMax = idleWaitInitial * 2 ** 6; /* 640 sec */
const hlsTargetMinBitrate = 4000 * 1000;
const hlsTargetMaxBitrate = 8000 * 1000;
const recreateStreamMinRatio = 0.5;
const recreateSourceMinRatio = 0.8;
const bitrateCapHeadroom = 1.3;
const progressPollIntervalMs = 2000;
const standardProcessingPipelineWidth = 2;
const jasnaProcessingPipelineWidth = 8;
// processQueue is a singleton, so this is also the process-wide discovery cap.
const maxConcurrentPlaylistInspections = 8;
const playlistFetchBatchSize = 200;
const videoPreviewFailurePolicyVersion = 2;
const sourceRetryDelayMs = 2 * 1000;
const transientRetryInitialDelayMs = 30 * 1000;
const transientRetryMaximumDelayMs = 10 * 60 * 1000;

class PersistedVideoFailureError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), {
            cause,
        });
        this.name = "PersistedVideoFailureError";
    }
}

/**
 * Internal in-memory state shared by the functions in this module.
 *
 * This entire object will be reset on logout.
 */
class VideoState {
    /** Whether this desktop process has Jasna stream processing configured. */
    jasnaConfigured = false;
    /** Whether the configured Jasna uses the native concurrent job contract. */
    jasnaConcurrent = false;
    /** Generator emitted by the currently configured Jasna execution mode. */
    jasnaGenerator: string | undefined;
    /** Completed remote requests awaiting a successful metadata acknowledgement. */
    completedRemoteRecreateRequests = new Map<number, number>();
    /** Existing previews already verified against the current Jasna generator. */
    jasnaMigrationVerifiedFileIDs = new Set<number>();
    /**
     * `true` if the generation of HLS streams has been enabled on this client.
     */
    isHLSGenerationEnabled = false;
    /**
     * Subscriptions to {@link HLSGenerationStatus} updates attached using
     * {@link hlsGenerationStatusSubscribe}.
     */
    hlsGenerationStatusListeners: (() => void)[] = [];
    /**
     * Snapshot of the {@link HLSGenerationStatus} returned by the
     * {@link hlsGenerationStatusSnapshot} function.
     */
    hlsGenerationStatusSnapshot: HLSGenerationStatus | undefined;
    /**
     * Value of the {@link status} field in the last
     * {@link hlsGenerationStatusSnapshot}.
     */
    lastEnabledStatus: HLSGenerationEnabledStatus | undefined;
    /** Number of items processed in the current batch. */
    processingDone: number | undefined;
    /** Total items in the current batch (processed + remaining). */
    processingTotal: number | undefined;
    /** File ID currently being encoded. */
    currentFileID: number | undefined;
    /** Current encode progress [0,1] for the active file. */
    currentProgress: number | undefined;
    /** Items currently occupying the bounded processing pipeline. */
    activeVideoItems = new Map<number, VideoProcessingQueueItem>();
    /**
     * Queue of recently uploaded items waiting to be processed.
     */
    liveQueue: VideoProcessingQueueItem[] = [];
    /**
     * Active queue processor, if any.
     */
    queueProcessor: Promise<void> | undefined;
    /**
     * A promise that the main processing loop waits for in addition to the idle
     * timeout. Can be resolved using {@link resolveTick}.
     */
    tick: Promise<void> | undefined;
    /**
     * A function that can be called to resolve {@link tick}.
     *
     * See: [Note: Exiting idle wait of processing loop].
     */
    resolveTick: (() => void) | undefined;
    /**
     * The time to sleep if nothing is pending.
     *
     * Goes from {@link idleWaitInitial} to {@link idleWaitMax} in doublings.
     * Reset back to {@link idleWaitInitial} in case of any activity.
     */
    idleWait = idleWaitInitial;
    /** Last backfill summary written to the log, used to suppress duplicates. */
    lastBackfillSnapshot: string | undefined;
    /**
     * `true` if we have synced at least once with remote.
     *
     * We use this to gate the processing of the backfill queue to avoid
     * unnecessarily picking up files that have already been indexed elsewhere
     * (we'll still check before processing them, but still that's unnecessary
     * work this flag can save us).
     */
    haveSyncedOnce = false;
}

/**
 * State shared by the functions in this module. See {@link VideoState}.
 */
let _state = new VideoState();

/**
 * Reset any internal state maintained by the module.
 *
 * This is primarily meant as a way for stateful apps (e.g. photos) to clear any
 * user specific state on logout.
 */
export const resetVideoState = () => {
    // Note: We rely on [Note: Full reload on logout] to abort any in-flight
    // requests.
    _state = new VideoState();
};

/**
 * A function that can be used to subscribe to updates in the HLS generation
 * settings and status.
 *
 * See: [Note: Snapshots and useSyncExternalStore].
 */
export const hlsGenerationStatusSubscribe = (
    onChange: () => void,
): (() => void) => {
    _state.hlsGenerationStatusListeners.push(onChange);
    return () => {
        _state.hlsGenerationStatusListeners =
            _state.hlsGenerationStatusListeners.filter((l) => l != onChange);
    };
};

/**
 * Return the last know, cached {@link HLSGenerationStatus}.
 *
 * See also {@link hlsGenerationStatusSubscribe}.
 *
 * This function can be safely called even if {@link isHLSGenerationSupported}
 * is `false` (in such cases, it will always return `undefined`). This is so
 * that it can be unconditionally called as part of a React hook.
 *
 * A return value of `undefined` indicates that the HLS generation subsystem has
 * not been initialized yet.
 */
export const hlsGenerationStatusSnapshot = () =>
    _state.hlsGenerationStatusSnapshot;

const setHLSGenerationStatusSnapshot = (snapshot: HLSGenerationStatus) => {
    _state.hlsGenerationStatusSnapshot = snapshot;
    _state.hlsGenerationStatusListeners.forEach((l) => l());
};

const emitStatusSnapshot = () => {
    const enabled = _state.isHLSGenerationEnabled;
    if (!enabled) {
        setHLSGenerationStatusSnapshot({ enabled: false });
        return;
    }

    const status = _state.lastEnabledStatus;
    const snapshot: HLSGenerationStatus = { enabled: true };
    if (status) snapshot.status = status;
    if (status == "processing") {
        if (_state.processingDone !== undefined) {
            snapshot.processedCount = _state.processingDone;
        }
        if (_state.processingTotal !== undefined) {
            snapshot.totalCount = _state.processingTotal;
        }
        if (_state.currentProgress !== undefined) {
            snapshot.currentProgress = _state.currentProgress;
        }
    }

    setHLSGenerationStatusSnapshot(snapshot);
};

const emitProcessingSnapshot = () => {
    if (!_state.isHLSGenerationEnabled) return;
    if (_state.lastEnabledStatus != "processing") return;
    emitStatusSnapshot();
};

const resetProcessingStats = () => {
    _state.processingDone = undefined;
    _state.processingTotal = undefined;
    _state.currentFileID = undefined;
    _state.currentProgress = undefined;
};

/**
 * A variant of {@link setHLSGenerationStatusSnapshot} that only triggers an
 * update of the snapshot if the enabled state is different from the last known
 * enabled state.
 */
const updateSnapshotIfNeeded = (
    status: HLSGenerationEnabledStatus | undefined,
) => {
    if (!_state.isHLSGenerationEnabled) return;
    if (status != _state.lastEnabledStatus) {
        _state.lastEnabledStatus = status;
        emitStatusSnapshot();
    }
};

/**
 * Return `true` if this client is capable of generating HLS streams for
 * uploaded videos.
 */
export const isHLSGenerationSupported = isDesktop;

/**
 * Initialize the video processing subsystem unless the user has disabled HLS
 * generation in settings.
 */
export const initVideoProcessing = async () => {
    let enabled = false;
    if (await savedGenerateHLS()) enabled = true;

    _state.isHLSGenerationEnabled = enabled;

    // Update snapshot to reflect the enabled setting. The status will get
    // filled in when we tick.
    _state.lastEnabledStatus = undefined;
    resetProcessingStats();
    emitStatusSnapshot();
};

/**
 * Return the persisted user preference for HLS generation.
 */
const savedGenerateHLS = async () => await getKVB("generateHLS");

/**
 * Update the persisted user preference for HLS generation.
 *
 * Use {@link savedGenerateHLS} to get the persisted value back.
 */
const saveGenerateHLS = (enabled: boolean) => setKV("generateHLS", enabled);

/**
 * Enable or disable (toggle) the HLS generation on this client.
 *
 * When HLS generation is enabled, this client will process videos to generate a
 * streamable variant of them.
 *
 * Precondition: {@link isHLSGenerationSupported} must be `true`.
 */
export const toggleHLSGeneration = async () => {
    if (!isHLSGenerationSupported) {
        assertionFailed();
        return;
    }

    const enabled = !_state.isHLSGenerationEnabled;

    // Clear transient fields.
    _state.lastEnabledStatus = undefined;
    resetProcessingStats();

    // Update disk.
    await saveGenerateHLS(enabled);
    // Update in memory.
    _state.isHLSGenerationEnabled = enabled;

    // Update snapshot. Right now we only set the enabled setting. The status
    // will get filled in when we tick.
    emitStatusSnapshot();

    // Wake up the processor if needed.
    if (enabled) tickNow();
};

export interface HLSPlaylistData {
    /** A data URL to a HLS playlist that streams the video. */
    playlistURL: string;
    /** The width of the video (px). */
    width: number;
    /** The height of the video (px). */
    height: number;
    /** The versioned pipeline that generated the stream, if recorded. */
    generator?: string;
}

/**
 * See: [Note: Caching HLS playlist data] for the semantics of "skip".
 */
export type HLSPlaylistDataForFile = HLSPlaylistData | "skip" | undefined;

/**
 * Return a HLS playlist that can be used to stream playback of then given video
 * {@link file}.
 *
 * @param file An {@link EnteFile} of type video.
 *
 * @param publicAlbumsCredentials Credentials to use for fetching the HLS
 * playlist when we are running in the context of the public albums app. If
 * these are not specified, then the credentials of the logged in user are used.
 *
 * @returns The HLS playlist as a string (along with the dimensions of the video
 * it will play), or `undefined` if there is no video preview associated with
 * the given file.
 *
 * See: [Note: Video playlist and preview]
 *
 * ---
 *
 * [Note: Caching HLS playlist data]
 *
 * The playlist data can be cached in an asymmetric manner.
 *
 * - If a file has a corresponding HLS playlist, then currently there is no
 *   scenario (apart from file deletion, where the playlist also gets deleted)
 *   where the playlist is deleted after being created. There is a limit to the
 *   validity of the pre-signed chunk URLs within the playlist we create (which
 *   we do handle, see `createHLSPlaylistItemDataValidity`), but the original
 *   playlist itself does not change. Updates are technically possible, but
 *   apart from a misbehaving client, are not expected (and should be no-ops in
 *   the rare cases they happen, since effectively same playlist should get
 *   regenerated again). All in all, this means that a positive result ("this
 *   file has a playlist") can be cached indefinitely.
 *
 * - If a file does not have a HLS playlist, it might be because it is not
 *   eligible for being streamed (e.g. it is already small and in a compatible
 *   codec). See [Note: Marking files which do not need video processing] for
 *   more details of this case. In particular, we can cache this state in memory
 *   indefinitely too, since there isn't a current case where either this
 *   eligibility can change, or the client gain the ability to handle them
 *   without restarting.
 *
 * - Finally, if a file does not have an HLS playlist but and it is eligible for
 *   being streamed, then a client (this one, or a different one) can process it
 *   at any arbitrary time. So the negative result ("this file does not have a
 *   playlist") cannot be cached.
 *
 * So while we can easily cache the first case ("this file has a playlist") and
 * second case ("this file doesn't need a streaming variant"), we need to deal
 * with the third case ("this file does not have a playlist") by marking the
 * cached values as "transient" and always recheck for a playlist when opening
 * the slide.
 */
export const hlsPlaylistDataForFile = async (
    file: EnteFile,
    publicAlbumsCredentials?: PublicAlbumsCredentials,
    publicMemoryCredentials?: PublicMemoryCredentials,
): Promise<HLSPlaylistDataForFile> => {
    ensurePrecondition(file.metadata.fileType == FileType.video);

    if (file.pubMagicMetadata?.data.sv == 1) {
        return "skip";
    }

    const playlistFileData = await fetchFileData(
        "vid_preview",
        file.id,
        publicAlbumsCredentials,
        publicMemoryCredentials,
    );
    if (!playlistFileData) return undefined;

    const {
        type,
        playlist: playlistTemplate,
        width,
        height,
        generator,
    } = await decryptPlaylistJSON(playlistFileData, file);

    // A playlist format the current client does not understand.
    if (type != "hls_video") return undefined;

    const videoURL = await fetchFilePreviewData(
        "vid_preview",
        file.id,
        publicAlbumsCredentials,
        publicMemoryCredentials,
    );
    if (!videoURL) return undefined;

    // [Note: HLS playlist format]
    //
    // The decrypted playlist is a regular HLS playlist for an encrypted media
    // stream, except that it uses a placeholder "output.ts" which needs to be
    // replaced with the URL of the actual encrypted video data. A single URL
    // pointing to the entire encrypted video data suffices; the individual
    // chunks are fetched by HTTP range requests.
    //
    // Here is an example of what the contents of the `playlist` variable might
    // look like at this point:
    //
    //     #EXTM3U
    //     #EXT-X-VERSION:4
    //     #EXT-X-TARGETDURATION:8
    //     #EXT-X-MEDIA-SEQUENCE:0
    //     #EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,XjvG7qeRrsOpPUbJPh2Ikg==",IV=0x00000000000000000000000000000000
    //     #EXTINF:8.333333,
    //     #EXT-X-BYTERANGE:3046928@0
    //     output.ts
    //     #EXTINF:8.333333,
    //     #EXT-X-BYTERANGE:3012704@3046928
    //     output.ts
    //     #EXTINF:2.200000,
    //     #EXT-X-BYTERANGE:834736@6059632
    //     output.ts
    //     #EXT-X-ENDLIST
    //
    // The HLS playlist format is specified in RFC 8216:
    // https://datatracker.ietf.org/doc/html/rfc8216
    //
    // Some notes pertinent to us:
    //
    // - A URI line identifies a media segment.
    //
    // - The EXTINF tag specifies the duration of the media segment (applies
    //   only to the next URI line that follows it in the playlist).
    //
    // - The EXT-X-BYTERANGE tag indicates that a media segment is a sub-range
    //   of the resource identified by its URI (applies only to the next URI
    //   line that follows it in the playlist). The value should be of the
    //   format `<n>[@<o>]` where n is an integer indicating the length of the
    //   sub-range in bytes, and if present, o is the integer indicating the
    //   start of the sub-range as a byte offset from the beginning of the
    //   resource. If o is not present, the sub-range begins at the next byte
    //   following the sub-range of the previous media segment.
    //
    // - Media segments may be encrypted, and the EXT-X-KEY tag specifies how to
    //   decrypt them. It applies to all subsequent media segment (until another
    //   EXT-X-KEY). Value is an `<attribute-list>`, consisting of the METHOD
    //   (AES-128 for us), URI and IV attributes. The URI attribute value is a
    //   quoted string containing a URI that specifies how to obtain the key.

    const playlist = playlistTemplate.replaceAll(
        "\noutput.ts",
        `\n${videoURL}`,
    );

    // From the RFC
    //
    // > Each playlist file must be identifiable either by the path component of
    // > its URI (ending with either ".m3u8" or ".m3u") or by its HTTP
    // > Content-Type ("application/vnd.apple.mpegurl" or "audio/mpegurl").
    // > Clients should refuse to parse playlists that are not so identified.
    //
    // As of now (2025), there isn't a way to set the filename for a URL created
    // via createObjectURL, so instead we create a "data:" URL where the MIME
    // type can be specified.
    //
    // The generated data URL be of the form:
    //
    //     data:application/vnd.apple.mpegurl;base64,<base64-string>

    const playlistURL = await blobToDataURL(
        new Blob([playlist], { type: "application/vnd.apple.mpegurl" }),
    );

    return { playlistURL, width, height, generator };
};

const decryptPlaylistJSONObject = async (
    encryptedPlaylist: EncryptedBlob,
    file: EnteFile,
) => {
    const decryptedBytes = await decryptBlobBytes(encryptedPlaylist, file.key);
    const jsonString = await gunzip(decryptedBytes);
    return JSON.parse(jsonString) as unknown;
};

const decryptPlaylistJSON = async (
    encryptedPlaylist: EncryptedBlob,
    file: EnteFile,
) =>
    PlaylistJSON.parse(
        await decryptPlaylistJSONObject(encryptedPlaylist, file),
    );

/**
 * Convert a blob to a `data:` URL.
 */
const blobToDataURL = (blob: Blob) =>
    new Promise<string>((resolve) => {
        const reader = new FileReader();
        // We need to cast to a string here. This should be safe since MDN says:
        //
        // > the result attribute contains the data as a data: URL representing
        // > the file's data as a base64 encoded string.
        // >
        // > https://developer.mozilla.org/en-US/docs/Web/API/FileReader/readAsDataURL
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
    });

/**
 * Return the (persistent) {@link Set} containing the ids of the files which
 * have already been processed for generating their streaming variant.
 *
 * {@link savedProcessedVideoFileIDs} and its sibling
 * {@link savedFailedVideoFileIDs} are mutually exclusive - that is, a file ID
 * will be present in only one of them at max. We maintain that invariant in the
 * higher level `mark*` functions when updating either of these persisted sets.
 *
 * The data is retrieved from persistent storage (KV DB), where it is stored as
 * an array.
 */
const savedProcessedVideoFileIDs = () =>
    // See: [Note: Avoiding Zod parsing for large DB arrays]
    getKV("videoPreviewProcessedFileIDs").then((v) => new Set(v as number[]));

/**
 * Return the (persistent) {@link Set} containing the ids of the files for which
 * an attempt to generate a streaming variant failed locally.
 *
 * @see also {@link savedProcessedVideoFileIDs}.
 */
const savedFailedVideoFileIDs = () =>
    // See: [Note: Avoiding Zod parsing for large DB arrays]
    getKV("videoPreviewFailedFileIDs").then((v) => new Set(v as number[]));

/**
 * Update the persisted set of IDs of files which have already been processed
 * and have a video preview generated (either on this client, or elsewhere).
 *
 * @see also {@link savedProcessedVideoFileIDs}.
 */
const saveProcessedVideoFileIDs = (videoFileIDs: Set<number>) =>
    setKV("videoPreviewProcessedFileIDs", Array.from(videoFileIDs));

/**
 * Update the persisted set of IDs of files for which attempt to generate a
 * video preview failed on this client.
 *
 * @see also {@link savedProcessedVideoFileIDs}.
 */
const saveFailedVideoFileIDs = (videoFileIDs: Set<number>) =>
    setKV("videoPreviewFailedFileIDs", Array.from(videoFileIDs));

/** Re-evaluate failures saved before the native Jasna v6 failure policy. */
const migrateVideoPreviewFailureStateIfNeeded = async () => {
    const savedVersion =
        (await getKVN("videoPreviewFailurePolicyVersion")) ?? 0;
    if (savedVersion >= videoPreviewFailurePolicyVersion) return;

    const failedIDs = await savedFailedVideoFileIDs();
    if (failedIDs.size > 0) {
        await saveFailedVideoFileIDs(new Set());
        log.info(
            `Reset ${failedIDs.size} saved video preview failure(s) for policy version ${videoPreviewFailurePolicyVersion}`,
        );
    }
    await setKV(
        "videoPreviewFailurePolicyVersion",
        videoPreviewFailurePolicyVersion,
    );
};

/**
 * Mark the provided file ID as having been processed to generate a video
 * preview.
 *
 * The mark is persisted locally in IndexedDB (KV DB), so will persist across
 * app restarts (but not across logouts).
 *
 * @see also {@link savedProcessedVideoFileIDs}.
 */
const markProcessedVideoFileID = async (fileID: number) => {
    const savedIDs = await savedProcessedVideoFileIDs();
    const failedIDs = await savedFailedVideoFileIDs();
    savedIDs.add(fileID);
    if (failedIDs.delete(fileID)) await saveFailedVideoFileIDs(failedIDs);
    await saveProcessedVideoFileIDs(savedIDs);
};

/**
 * Mark multiple file IDs as processed. Plural variant of
 * {@link markProcessedVideoFileID}.
 */
const markProcessedVideoFileIDs = async (fileIDs: Set<number>) => {
    const savedIDs = await savedProcessedVideoFileIDs();
    const failedIDs = await savedFailedVideoFileIDs();
    await Promise.all([
        saveProcessedVideoFileIDs(savedIDs.union(fileIDs)),
        saveFailedVideoFileIDs(failedIDs.difference(fileIDs)),
    ]);
};

/**
 * Mark the provided file as having failed in a non-transient manner when we
 * tried processing it to generate a video preview on this client.
 *
 * Similar to [Note: Transient and permanent indexing failures], we attempt to
 * separate failures into two categories - transients, which leave no mark no
 * the DB so that the file eventually gets retried; and permanent, where we keep
 * a persistent record of failure so that this client does not go into a loop
 * reattempting preview generation for the specific unprocessable (to the best
 * of the current client's ability) item.
 *
 * The mark is local only, and will be reset on logout, or if another client
 * with a different able is able to process it.
 */
const markFailedVideoFile = async (file: EnteFile) => {
    log.info(`Generate HLS for ${fileLogID(file)} | failed`);
    const failedIDs = await savedFailedVideoFileIDs();
    failedIDs.add(file.id);
    await saveFailedVideoFileIDs(failedIDs);
};

/**
 * Return the persisted time when we last synced processed file IDs with remote.
 *
 * The returned value is an epoch millisecond value suitable to be passed to
 * {@link syncUpdatedFileDataFileIDs}.
 */
const savedSyncLastUpdatedAt = () => getKVN("videoPreviewSyncLastUpdatedAt");

/**
 * Update the persisted timestamp used for syncing processed file IDs with
 * remote.
 *
 * Use {@link savedSyncLastUpdatedAt} to get the persisted value back.
 */
const saveSyncLastUpdatedAt = (lastUpdatedAt: number) =>
    setKV("videoPreviewSyncLastUpdatedAt", lastUpdatedAt);

/**
 * Fetch IDs of files from remote that have been processed by other clients
 * since the last time we checked.
 */
const pullProcessedFileIDs = async () =>
    syncUpdatedFileDataFileIDs(
        "vid_preview",
        (await savedSyncLastUpdatedAt()) ?? 0,
        async ({ fileIDs, lastUpdatedAt }) => {
            for (const fileID of fileIDs)
                _state.jasnaMigrationVerifiedFileIDs.delete(fileID);
            await Promise.all([
                markProcessedVideoFileIDs(fileIDs),
                saveSyncLastUpdatedAt(lastUpdatedAt),
            ]);
        },
    );

/**
 * Remove any saved entries for file IDs which were previously in trash but now
 * have been permanently deleted.
 *
 * This is called when processing the trash diff. It gives us a hook to clear
 * these IDs from our video processing related local state.
 *
 * See: [Note: Pruning stale status-diff entries]
 *
 * It is a no-op when we're running in the context of the web app (since it
 * doesn't currently process videos, so doesn't need to keep any local state for
 * that purpose).
 */
export const videoPrunePermanentlyDeletedFileIDsIfNeeded = async (
    deletedFileIDs: Set<number>,
) => {
    if (!isHLSGenerationSupported) return;

    const existing = await savedProcessedVideoFileIDs();
    if (existing.size > 0) {
        const updated = existing.difference(deletedFileIDs);
        if (updated.size != existing.size) {
            await saveProcessedVideoFileIDs(updated);
        }
    }
};

/**
 * Trigger the desktop video-processing sync after a remote pull.
 *
 * Automatic processing and the backfill queue require the HLS preference to be
 * enabled. Explicit recreation requests received from a mobile client do not:
 * they are user initiated and must be handled by a synced desktop client even
 * when automatic HLS generation is disabled.
 *
 * This function is intended to be called during a full remote pull (See: [Note:
 * Remote pull]). It is a no-op on non-desktop clients. When automatic HLS
 * generation is enabled, it also pulls the list of already processed file IDs
 * from remote.
 *
 * At this point it also triggers processing of the backfill (if needed), but
 * doesn't wait for it to complete (which might take a time for big libraries).
 *
 * Calling it when a backfill has already been triggered by a previous sync is
 * also a no-op. However, a backfill does not start until at least one pull of
 * file IDs has been completed with remote, to avoid picking up work on file IDs
 * that have already been processed elsewhere.
 */
export const videoProcessingSyncIfNeeded = async () => {
    if (!isHLSGenerationSupported) return;

    // The `haveSyncedOnce` flag tracks whether or not a sync has happened for
    // the app, and is not specific to video processing. We always set it even
    // if HLS generation is currently disabled so that we can immediately start
    // processing the backfill if it gets video processing gets enabled during
    // the app's session, without waiting for the next sync to happen.
    _state.haveSyncedOnce = true;

    let jasnaStatus: Awaited<
        ReturnType<typeof readJasnaStreamProcessingStatus>
    > = { configured: false, concurrent: false };
    try {
        jasnaStatus = await readJasnaStreamProcessingStatus(ensureElectron());
    } catch (error) {
        log.warn("Failed to read Jasna stream processing status", error);
    }
    _state.jasnaConfigured = jasnaStatus.configured;
    _state.jasnaConcurrent = jasnaStatus.concurrent;
    if (_state.jasnaGenerator != jasnaStatus.generator)
        _state.jasnaMigrationVerifiedFileIDs.clear();
    _state.jasnaGenerator = jasnaStatus.generator;

    if (isHLSGenerationEnabled()) {
        if (_state.jasnaConcurrent)
            await migrateVideoPreviewFailureStateIfNeeded();
        await pullProcessedFileIDs();
    }

    await videoProcessingSyncRemoteRecreateRequestsIfNeeded();

    if (isHLSGenerationEnabled()) tickNow(); /* if not already ticking */
};

/**
 * Queue synced mobile recreation requests ahead of normal desktop work.
 *
 * Unlike automatic HLS generation, these explicit requests are independent of
 * the desktop HLS preference.
 */
export const videoProcessingSyncRemoteRecreateRequestsIfNeeded = async () => {
    if (!isHLSGenerationSupported) return;

    const userID = ensureLocalUser().id;
    const files = uniqueFilesByID(await savedCollectionFiles());
    const pending = files.filter((file) => {
        const metadata = file.pubMagicMetadata?.data;
        const request = metadata?.streamRecreateRequest ?? 0;
        const acknowledged = metadata?.streamRecreateAck ?? 0;
        return (
            file.ownerID == userID &&
            file.metadata.fileType == FileType.video &&
            request > acknowledged
        );
    });
    const requested: EnteFile[] = [];
    for (const file of pending) {
        const request = file.pubMagicMetadata!.data.streamRecreateRequest!;
        if (
            (_state.completedRemoteRecreateRequests.get(file.id) ?? 0) >=
            request
        ) {
            await acknowledgeRemoteRecreateRequest(file, request);
        } else {
            requested.push(file);
        }
    }
    if (requested.length > 0) {
        log.info(
            `Queued ${requested.length} synced mobile stream recreation request(s)`,
        );
        enqueueVideoProcessingItems(
            requested.map((file) => ({
                file,
                forceRecreate: true,
                priority: true,
                remoteRecreateRequest:
                    file.pubMagicMetadata!.data.streamRecreateRequest,
            })),
        );
    }
};

const acknowledgeRemoteRecreateRequest = async (
    file: EnteFile,
    request: number,
) => {
    try {
        await updateFilePublicMagicMetadata(file, {
            streamRecreateAck: request,
        });
        if (
            (_state.completedRemoteRecreateRequests.get(file.id) ?? 0) <=
            request
        ) {
            _state.completedRemoteRecreateRequests.delete(file.id);
        }
        log.info(
            `Acknowledged synced mobile stream recreation for ${fileLogID(file)} | request=${request}`,
        );
    } catch (e) {
        log.warn(
            `Failed to acknowledge synced mobile stream recreation for ${fileLogID(file)}`,
            e,
        );
    }
};

const enqueueVideoProcessingItems = (items: VideoProcessingQueueItem[]) => {
    if (items.length === 0) return;

    const queuedByID = new Map<number, VideoProcessingQueueItem>();
    for (const queued of _state.liveQueue) {
        queuedByID.set(queued.file.id, queued);
    }

    let addedCount = 0;
    let updatedExisting = false;
    const priorityItems: VideoProcessingQueueItem[] = [];
    const mergeRemoteRequest = (
        target: VideoProcessingQueueItem,
        source: VideoProcessingQueueItem,
    ) => {
        if (
            source.remoteRecreateRequest !== undefined &&
            source.remoteRecreateRequest > (target.remoteRecreateRequest ?? 0)
        ) {
            target.remoteRecreateRequest = source.remoteRecreateRequest;
            target.file = source.file;
            return true;
        }
        return false;
    };
    for (const item of items) {
        const existing = queuedByID.get(item.file.id);
        if (existing) {
            if (mergeRemoteRequest(existing, item)) updatedExisting = true;
            if (item.forceRecreate && !existing.forceRecreate) {
                existing.forceRecreate = true;
                updatedExisting = true;
            }
            if (!existing.timestampedUploadItem && item.timestampedUploadItem) {
                existing.timestampedUploadItem = item.timestampedUploadItem;
                updatedExisting = true;
            }
            if (item.priority) {
                if (!existing.priority) {
                    existing.priority = true;
                    updatedExisting = true;
                }
                const index = _state.liveQueue.indexOf(existing);
                if (index > 0) {
                    _state.liveQueue.splice(index, 1);
                    priorityItems.push(existing);
                    updatedExisting = true;
                }
            }
            continue;
        }
        const active = _state.activeVideoItems.get(item.file.id);
        if (active) mergeRemoteRequest(active, item);
        if (active && (!item.forceRecreate || active.forceRecreate)) {
            continue;
        }
        if (item.priority) priorityItems.push(item);
        else _state.liveQueue.push(item);
        queuedByID.set(item.file.id, item);
        addedCount += 1;
    }
    _state.liveQueue.unshift(...priorityItems);

    if (addedCount === 0 && !updatedExisting) return;

    if (_state.lastEnabledStatus == "processing" && addedCount > 0) {
        _state.processingDone ??= 0;
        _state.processingTotal =
            (_state.processingTotal ?? _state.processingDone) + addedCount;
        emitProcessingSnapshot();
    }

    tickNow();
};

/**
 * Create a streamable HLS playlist for a video uploaded from this client.
 *
 * This function is called by the uploader when it uploads a new file from this
 * client, allowing us to create its streamable variant without needing to
 * redownload the video.
 *
 * It only does the processing if we're running in the context of the desktop
 * app as the video processing is resource intensive. In particular, processing
 * large videos with the Wasm ffmpeg implementation can cause the app to crash,
 * on mobile devices (see https://github.com/ffmpegwasm/ffmpeg.wasm/issues/851).
 * In contrast, the desktop app can us the efficient native FFmpeg integration.
 *
 * Note that this function is an optimization. Even if we don't process the
 * video at this time (e.g. if the video processor can't keep up with the
 * uploads), we will eventually process it later as part of a backfill.
 *
 * @param file The {@link EnteFile} that got uploaded (video or otherwise).
 *
 * @param processableUploadItem The item that was uploaded. This can be used to
 * read the contents of the file that got uploaded directly from disk instead of
 * needing to download it again.
 */
export const processVideoNewUpload = (
    file: EnteFile,
    processableUploadItem: ProcessableUploadItem,
) => {
    if (!isHLSGenerationSupported) return;
    if (!isHLSGenerationEnabled()) return;
    if (file.metadata.fileType != FileType.video) return;
    if (processableUploadItem instanceof File) {
        // While the types don't guarantee it, we really shouldn't be getting
        // here. The only time a processableUploadItem can be File when we're
        // running in the desktop app is when an edited image copy is being
        // saved. But we've already checked above that the file which was
        // uploaded was a video.
        assertionFailed();
        return;
    }

    enqueueVideoProcessingItems([
        { file, timestampedUploadItem: processableUploadItem },
    ]);
};

export const recreateVideoStreams = (files: EnteFile[]) => {
    if (!isHLSGenerationSupported) return;
    if (!isHLSGenerationEnabled()) return;
    if (files.length === 0) return;

    const userID = ensureLocalUser().id;
    const videoFiles = uniqueFilesByID(files).filter(
        (file) =>
            file.metadata.fileType == FileType.video && file.ownerID == userID,
    );
    if (videoFiles.length === 0) return;

    log.info(
        `Queued ${videoFiles.length} video(s) for priority stream recreation`,
    );
    enqueueVideoProcessingItems(
        videoFiles.map((file) => ({
            file,
            forceRecreate: true,
            priority: true,
        })),
    );
};

/**
 * If {@link processQueue} is not already running, start it.
 *
 * If there is an existing {@link resolveTick} so that if perchance
 * {@link processQueue} was waiting on an idle timeout, it wakes up now.
 *
 * Also create a new {@link tick} and {@link resolveTick} pair for use by
 * subsequent calls to {@link tickNow}
 */
const tickNow = () => {
    // See: [Note: Exiting idle wait of processing loop] for what this function
    // is trying to do.

    // Resolve the existing tick (if any).
    if (_state.resolveTick) _state.resolveTick();

    // Create a new resolvable pair.
    _state.tick = new Promise((r) => (_state.resolveTick = r));

    // Start the processor if it isn't already running.
    _state.queueProcessor ??= processQueue();
};

export const isHLSGenerationEnabled = () => _state.isHLSGenerationEnabled;

/** Whether an explicit mobile recreation request is waiting in the live queue. */
const hasPendingRemoteRecreateWork = () =>
    _state.liveQueue.some((item) => item.remoteRecreateRequest !== undefined);

/**
 * The video processing loop prefers items in the liveQueue, otherwise working
 * from the backlog. Jasna keeps eight items in flight so its bounded native
 * queue can supply the model-specific batches. Other HLS paths keep two.
 *
 * [Note: Exiting idle wait of processing loop]
 *
 * The following toy example illustrates the overall mechanism:
 *
 *     let resolveTick
 *     let tick = new Promise((r) => (resolveTick = r));
 *
 *     const tickNow = () => {
 *         resolveTick();
 *         tick = new Promise((r) => (resolveTick = r));
 *     }
 *
 *     const f = async () => {
 *         for (let i of [1, 2, 3, 4, 5]) {
 *             const wait = new Promise((r) => setTimeout(r, i * 1e3));
 *             await Promise.race([wait, tick]);
 *         }
 *     }
 *
 *     f()
 *
 *     setTimeout(tickNow, 2500);
 *     setTimeout(tickNow, 5000);
 *     setTimeout(tickNow, 5500);
 *
 * The `Promise.race([wait, tick])` means that the loop will proceed to the next
 * item either if the timeout expires, or if tick resolves. Thus the same
 * function can handle both the internally determined processing of backfill
 * batches, and the externally triggered processing of live uploads.
 */
const processQueue = async () => {
    if (!isHLSGenerationSupported) {
        assertionFailed(); /* we shouldn't have come here */
        return;
    }
    if (!isHLSGenerationEnabled() && !hasPendingRemoteRecreateWork()) return;

    const userID = ensureLocalUser().id;

    // Permanent source failures are stored in the local DB. Transient failures
    // use a bounded cooldown so they are retried without creating a hot loop.
    const transientRetries = new TransientRetryTracker(
        transientRetryInitialDelayMs,
        transientRetryMaximumDelayMs,
    );

    let bq: typeof _state.liveQueue | undefined;
    const active = new Map<Promise<void>, VideoProcessingQueueItem>();
    const activeFileIDs = new Set<number>();
    const processingPipelineWidth = () =>
        _state.jasnaConcurrent
            ? jasnaProcessingPipelineWidth
            : standardProcessingPipelineWidth;
    let lastLoggedQueueSnapshot: string | undefined;

    const remainingCount = () => _state.liveQueue.length + (bq?.length ?? 0);

    const emitPipelineSnapshot = () => {
        _state.processingDone ??= 0;
        const observedTotal =
            _state.processingDone + active.size + remainingCount();
        _state.processingTotal = Math.max(
            _state.processingTotal ?? 0,
            observedTotal,
        );
        const queueSnapshot = `${_state.processingDone}/${_state.processingTotal}/${active.size}/${remainingCount()}`;
        if (queueSnapshot != lastLoggedQueueSnapshot) {
            lastLoggedQueueSnapshot = queueSnapshot;
            log.info(
                `HLS queue | done=${_state.processingDone} total=${_state.processingTotal} active=${active.size} queued=${remainingCount()}`,
            );
        }
        emitProcessingSnapshot();
    };

    const startItem = (item: VideoProcessingQueueItem) => {
        activeFileIDs.add(item.file.id);
        _state.activeVideoItems.set(item.file.id, item);
        if (_state.currentFileID === undefined) {
            _state.currentFileID = item.file.id;
            _state.currentProgress = undefined;
        }

        const task = (async () => {
            let shouldRequeue = false;
            try {
                await processQueueItem(item);
                if (item.remoteRecreateRequest !== undefined) {
                    _state.completedRemoteRecreateRequests.set(
                        item.file.id,
                        item.remoteRecreateRequest,
                    );
                    await acknowledgeRemoteRecreateRequest(
                        item.file,
                        item.remoteRecreateRequest,
                    );
                }
                await markProcessedVideoFileID(item.file.id);
                transientRetries.clear(item.file.id);
                _state.idleWait = idleWaitInitial;
            } catch (e) {
                log.error(`Failed to process video ${fileLogID(item.file)}`, e);
                if (e instanceof PersistedVideoFailureError) {
                    transientRetries.clear(item.file.id);
                } else {
                    const retry = transientRetries.recordFailure(item.file.id);
                    shouldRequeue = true;
                    log.warn(
                        `HLS queue | retry file=${item.file.id} attempt=${retry.attempt} after=${Math.ceil(retry.delayMs / 1000)}s`,
                    );
                }
            } finally {
                for (const [activeTask, activeItem] of active) {
                    if (activeItem === item) {
                        active.delete(activeTask);
                        break;
                    }
                }
                activeFileIDs.delete(item.file.id);
                _state.activeVideoItems.delete(item.file.id);
                if (shouldRequeue) enqueueVideoProcessingItems([item]);
                _state.processingDone = (_state.processingDone ?? 0) + 1;
                if (_state.currentFileID == item.file.id) {
                    const next = active.values().next().value;
                    _state.currentFileID = next?.file.id;
                    _state.currentProgress = undefined;
                }
                emitPipelineSnapshot();
            }
        })();
        active.set(task, item);
        updateSnapshotIfNeeded("processing");
        emitPipelineSnapshot();
    };

    while (isHLSGenerationEnabled() || hasPendingRemoteRecreateWork()) {
        let loadedBackfill = false;
        while (active.size < processingPipelineWidth()) {
            const coolingFileIDs = transientRetries.blockedFileIDs();
            const liveIndex = _state.liveQueue.findIndex(
                (candidate) =>
                    !activeFileIDs.has(candidate.file.id) &&
                    !coolingFileIDs.has(candidate.file.id) &&
                    (isHLSGenerationEnabled() ||
                        candidate.remoteRecreateRequest !== undefined),
            );
            let item =
                liveIndex >= 0
                    ? _state.liveQueue.splice(liveIndex, 1)[0]
                    : undefined;
            if (
                !item &&
                isHLSGenerationEnabled() &&
                !bq?.length &&
                !loadedBackfill
            ) {
                loadedBackfill = true;
                if (_state.haveSyncedOnce) {
                    const excludedFileIDs = new Set([
                        ...coolingFileIDs,
                        ...activeFileIDs,
                    ]);
                    try {
                        bq = await backfillQueue(userID, excludedFileIDs);
                    } catch (e) {
                        // With no queued item, the outer loop enters its idle
                        // wait and retries this lookup on the next iteration.
                        bq = [];
                        log.warn(
                            "Failed to determine HLS backfill queue; will retry after idle wait",
                            e,
                        );
                    }
                } else if (active.size == 0) {
                    log.info("Not attempting backfill until first sync");
                }
            }
            while (!item && bq?.length) {
                const candidate = bq.pop();
                if (candidate && !activeFileIDs.has(candidate.file.id)) {
                    item = candidate;
                }
            }
            if (!item) break;
            startItem(item);
        }

        if (active.size > 0) {
            await Promise.race(active.keys());
        } else {
            resetProcessingStats();
            updateSnapshotIfNeeded("idle");

            const configuredIdleWait = _state.idleWait;
            _state.idleWait = Math.min(configuredIdleWait * 2, idleWaitMax);
            const nextRetryDelay = transientRetries.nextDelay();
            const idleWait =
                nextRetryDelay !== undefined
                    ? Math.min(configuredIdleWait, nextRetryDelay)
                    : configuredIdleWait;

            // `tick` allows the sleep to be interrupted when there is
            // potential activity.
            if (!_state.tick) assertionFailed();
            const tick = _state.tick!;

            log.debug(() => ["gen-hls", { idleWait }]);
            await Promise.race([tick, wait(idleWait)]);
        }
    }

    await Promise.allSettled(active.keys());

    resetProcessingStats();
    updateSnapshotIfNeeded(undefined);

    _state.queueProcessor = undefined;
};

const calculateBitrate = (sizeBytes: number, durationSeconds: number) => {
    if (!sizeBytes || !durationSeconds) return undefined;
    if (durationSeconds <= 0) return undefined;
    return (sizeBytes * 8) / durationSeconds;
};

const shouldRecreateLowQualityStream = async (
    file: EnteFile,
    playlistFileData: EncryptedBlob,
) => {
    const playlistJSON = await decryptPlaylistJSONObject(
        playlistFileData,
        file,
    );
    const parsedPlaylist = PlaylistJSON.safeParse(playlistJSON);
    if (!parsedPlaylist.success) {
        if (
            shouldRecreateInvalidPlaylistForJasnaMigration(
                _state.jasnaConfigured,
                playlistJSON,
                parsedPlaylist.error,
            )
        ) {
            log.info(
                `Generate HLS for ${fileLogID(file)} | recreate-invalid-dimensions`,
            );
            return true;
        }
        throw parsedPlaylist.error;
    }
    const { type, size, generator } = parsedPlaylist.data;
    if (type != "hls_video") return false;
    if (_state.jasnaGenerator && generator != _state.jasnaGenerator)
        return true;

    const durationSeconds = file.metadata.duration;
    const sourceSize = file.info?.fileSize;
    if (!durationSeconds || durationSeconds <= 0) return false;
    if (!sourceSize || sourceSize <= 0) return false;
    if (!size || size <= 0) return false;

    const streamBitrate = calculateBitrate(size, durationSeconds);
    const sourceBitrate = calculateBitrate(sourceSize, durationSeconds);
    if (!streamBitrate || !sourceBitrate) return false;

    const cappedTargetBitrate = Math.min(
        hlsTargetMaxBitrate,
        sourceBitrate * bitrateCapHeadroom,
    );
    const minStreamBitrate = Math.max(
        hlsTargetMinBitrate,
        cappedTargetBitrate * recreateStreamMinRatio,
    );
    const minSourceBitrate = hlsTargetMaxBitrate * recreateSourceMinRatio;

    return (
        streamBitrate < minStreamBitrate && sourceBitrate >= minSourceBitrate
    );
};

const selectLowQualityRecreateCandidates = async (
    files: EnteFile[],
    maxResults: number,
) => {
    if (maxResults <= 0 || files.length === 0) return [];

    const eligible = _state.jasnaConfigured
        ? files
        : files.filter((file) => file.metadata.duration && file.info?.fileSize);
    if (eligible.length === 0) return [];

    if (_state.jasnaConfigured) {
        const unchecked = eligible
            .toSorted((a, b) => a.id - b.id)
            .filter(
                (file) => !_state.jasnaMigrationVerifiedFileIDs.has(file.id),
            );
        let inspectedCount = 0;
        const candidates = await collectCandidatesInBatches(
            unchecked,
            playlistFetchBatchSize,
            maxResults,
            async (batch) => {
                inspectedCount += batch.length;
                const playlistDataByFileID = new Map(
                    (
                        await fetchFilesData(
                            "vid_preview",
                            batch.map((file) => file.id),
                        )
                    ).map((data) => [data.fileID, data]),
                );
                const results = await mapWithConcurrency(
                    batch,
                    maxConcurrentPlaylistInspections,
                    async (file) => {
                        const playlistFileData = playlistDataByFileID.get(
                            file.id,
                        );
                        if (!playlistFileData) return undefined;
                        try {
                            if (
                                await shouldRecreateLowQualityStream(
                                    file,
                                    playlistFileData,
                                )
                            )
                                return file;
                            _state.jasnaMigrationVerifiedFileIDs.add(file.id);
                        } catch (e) {
                            log.warn(
                                `Generate HLS for ${fileLogID(file)} | recreate-check failed`,
                                e,
                            );
                        }
                        return undefined;
                    },
                );
                return results.filter((file): file is EnteFile =>
                    Boolean(file),
                );
            },
        );
        if (inspectedCount > 0) {
            log.info(
                `HLS migration scan | inspected=${inspectedCount} unchecked=${unchecked.length} candidates=${candidates.length}`,
            );
        }
        return candidates;
    }

    const sampleSize = Math.min(eligible.length, Math.max(50, maxResults * 5));
    const sample = randomSample(eligible, sampleSize);
    const results = await mapWithConcurrency(
        sample,
        maxConcurrentPlaylistInspections,
        async (file) => {
            try {
                const playlistFileData = await fetchFileData(
                    "vid_preview",
                    file.id,
                );
                if (!playlistFileData) return undefined;
                if (
                    await shouldRecreateLowQualityStream(file, playlistFileData)
                )
                    return file;
            } catch (e) {
                log.warn(
                    `Generate HLS for ${fileLogID(file)} | recreate-check failed`,
                    e,
                );
            }
            return undefined;
        },
    );

    return results
        .filter((file): file is EnteFile => Boolean(file))
        .slice(0, maxResults);
};

/**
 * Return the next batch of videos that need to be processed.
 *
 * If there is nothing pending, return an empty array.
 *
 * @param userID The ID of the currently logged in user. This is used to filter
 * the files to only include those that are owned by the user.
 */
const backfillQueue = async (
    userID: number,
    excludedFileIDs: ReadonlySet<number>,
): Promise<VideoProcessingQueueItem[]> => {
    const allCollectionFiles = await savedCollectionFiles();
    const localTrashFileIDs = await savedTrashItemFileIDs();
    const allVideoFiles = uniqueFilesByID(
        allCollectionFiles.filter(
            (f) =>
                // Only files the user owns.
                f.ownerID == userID &&
                // Only videos.
                f.metadata.fileType == FileType.video &&
                // Not in trash.
                !localTrashFileIDs.has(f.id) &&
                // See: [Note: Marking files which do not need video processing]
                f.pubMagicMetadata?.data.sv != 1,
        ),
    );
    const videoFiles = excludeFilesByID(allVideoFiles, excludedFileIDs);

    const processedIDs = await savedProcessedVideoFileIDs();
    const failedIDs = await savedFailedVideoFileIDs();
    const doneIDs = processedIDs.union(failedIDs);
    const allPendingVideoCount = allVideoFiles.filter(
        (file) => !doneIDs.has(file.id),
    ).length;
    const pendingVideoFiles = videoFiles.filter((f) => !doneIDs.has(f.id));

    const maxBatchSize = 50;
    const minLowQualitySlots = 10;
    const pendingQuota = Math.max(0, maxBatchSize - minLowQualitySlots);

    const pendingBatch = randomSample(pendingVideoFiles, pendingQuota);
    const pendingIDs = new Set(pendingBatch.map((file) => file.id));
    const availableForLowQuality = maxBatchSize - pendingBatch.length;

    const processedVideoFiles = videoFiles.filter(
        (file) => processedIDs.has(file.id) && !failedIDs.has(file.id),
    );
    const lowQualityBatch = await selectLowQualityRecreateCandidates(
        processedVideoFiles,
        availableForLowQuality,
    );

    let batch = [...pendingBatch, ...lowQualityBatch];
    if (batch.length < maxBatchSize) {
        const remainingPending = pendingVideoFiles.filter(
            (file) => !pendingIDs.has(file.id),
        );
        const extraPending = randomSample(
            remainingPending,
            maxBatchSize - batch.length,
        );
        batch = [...batch, ...extraPending];
    }
    const processedVideoCount = allVideoFiles.filter((file) =>
        processedIDs.has(file.id),
    ).length;
    const failedVideoCount = allVideoFiles.filter((file) =>
        failedIDs.has(file.id),
    ).length;
    const snapshot = [
        allVideoFiles.length,
        allPendingVideoCount,
        processedVideoCount,
        failedVideoCount,
        excludedFileIDs.size,
        lowQualityBatch.length,
        batch.length,
    ].join("/");
    if (_state.lastBackfillSnapshot != snapshot) {
        _state.lastBackfillSnapshot = snapshot;
        log.info(
            `HLS backfill | videos=${allVideoFiles.length} pending=${allPendingVideoCount} processed=${processedVideoCount} failed=${failedVideoCount} excluded=${excludedFileIDs.size} recreate=${lowQualityBatch.length} selected=${batch.length}`,
        );
    }
    return batch.map((file) => ({ file }));
};

const updateCurrentProgress = (fileID: number, progress: number) => {
    if (_state.currentFileID != fileID) {
        if (_state.currentProgress !== undefined && _state.currentProgress < 1)
            return;
        _state.currentFileID = fileID;
        _state.currentProgress = undefined;
    }
    const clamped = Math.min(1, Math.max(0, progress));
    const previous = _state.currentProgress;
    if (previous !== undefined && Math.abs(previous - clamped) < 0.01) {
        return;
    }
    _state.currentProgress = clamped;
    emitProcessingSnapshot();
};

const clearCurrentProgress = (fileID: number) => {
    if (_state.currentFileID != fileID) return;
    _state.currentProgress = undefined;
    emitProcessingSnapshot();
};

const startHLSProgressPolling = (
    electron: ReturnType<typeof ensureElectron>,
    fileID: number,
) => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
        if (controller.signal.aborted) return;
        try {
            const progress = await readGenerateHLSProgress(electron, fileID);
            // Cleanup can abort while the awaited request is pending.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!controller.signal.aborted && progress !== undefined) {
                updateCurrentProgress(fileID, progress);
            }
        } catch (e) {
            log.debug(() => ["gen-hls-progress", { fileID, error: String(e) }]);
        }
        // Cleanup can abort while the awaited request is pending.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!controller.signal.aborted) {
            timeout = setTimeout(poll, progressPollIntervalMs);
        }
    };

    void poll();

    return () => {
        controller.abort();
        if (timeout) clearTimeout(timeout);
    };
};

/**
 * Generate and upload a streamable variant of the given {@link EnteFile}.
 *
 * [Note: Preview variant of videos]
 *
 * A preview variant of a video is created by transcoding it into a smaller,
 * streamable, and (more) widely supported format.
 *
 * 1. The video is transcoded into a format that is both smaller but is also
 *    using a much more widely supported codec so that it can be played back
 *    readily across browsers and OSes independent of the codec used by the
 *    source video.
 *
 * 2. We use a format that can be streamed back by the client instead of needing
 *    to download it all at once, and also generate an HLS playlist that refers
 *    to the offsets in the generated video file.
 *
 * 3. Both the generated video and the HLS playlist are then uploaded, E2EE.
 */
const processQueueItem = async ({
    file,
    timestampedUploadItem,
    forceRecreate,
}: VideoProcessingQueueItem) => {
    const electron = ensureElectron();

    log.debug(() => [
        "gen-hls",
        { file, timestampedUploadItem, forceRecreate },
    ]);

    if (!forceRecreate) {
        const playlistFileData = await fetchFileData("vid_preview", file.id);
        if (playlistFileData) {
            let shouldRecreate = false;
            try {
                shouldRecreate = await shouldRecreateLowQualityStream(
                    file,
                    playlistFileData,
                );
            } catch (e) {
                log.warn(
                    `Generate HLS for ${fileLogID(file)} | recreate-check failed`,
                    e,
                );
            }

            // Since video processing for even an individual item can take
            // substantial time, it is possible that an item might've gotten
            // processed on a different client in the interval between us
            // enqueuing it and us getting here.
            //
            // Bail out early to avoid unnecessary duplicate work.
            if (!shouldRecreate) {
                log.info(
                    `Generate HLS for ${fileLogID(file)} | already-processed`,
                );
                return;
            }

            log.info(
                `Generate HLS for ${fileLogID(file)} | recreate-low-quality`,
            );
        }
    } else {
        log.info(`Generate HLS for ${fileLogID(file)} | force-recreate`);
    }

    const uploadItem = timestampedUploadItem
        ? await fileSystemUploadItemIfUnchanged(
              timestampedUploadItem,
              electron.fs.statMtime,
          )
        : undefined;

    // [Note: Upload HLS video segment from node side]
    //
    // The generated video can be huge (multi-GB), too large to read it into
    // memory as an arrayBuffer.
    //
    // One option was to chain the video stream response (from the node side)
    // directly into a fetch request to `objectUploadURL`, however that requires
    // HTTP/2 (our servers support it, but self hosters' might not). Also that
    // approach won't work with retries on transient failures unless we
    // duplicate the stream beforehand, which invalidates the point of
    // streaming.
    //
    // Another mid-way option was to do it partially here - obtain the pre-signed
    // upload URLs here (since we already have the rest of the scaffolding to
    // make API requests), and then provide this pre-signed URL to the node side
    // so that it can directly upload the generated video segments.
    //
    // However, that then gets into a issue for multipart uploads since we don't
    // know the size of the generated HLS video segment file beforehand. We can
    // try to estimate it, and that is indeed what we started off with, and that
    // approach worked fine too.
    //
    // However, estimates being estimates, it felt better to make things more
    // deterministic by moving the request for the pre-signed URLs also to the
    // desktop app side. This also sidesteps the issue of passing along too much
    // data (the multipart upload URLs) as request params to the desktop app.
    // There was no specific issue again, it just felt that doing everything in
    // the desktop app is more simple and straightforward (at the cost of
    // needing set up of some API request scaffolding on the desktop side).
    //
    // Below we prepare the things that we need to pass to the desktop app to
    // allow it to make the API request for obtaining pre-signed upload URLs.
    const fetchURL = await apiURL("/files/data/preview-upload-url");
    const authToken = await ensureAuthToken();

    log.info(`Generate HLS for ${fileLogID(file)} | start`);

    let res: GenerateHLSResult | undefined;
    const stopProgressPolling = startHLSProgressPolling(electron, file.id);
    try {
        const maximumSourceAttempts = uploadItem ? 1 : 2;
        for (let attempt = 1; attempt <= maximumSourceAttempts; attempt++) {
            try {
                const sourceVideo =
                    uploadItem ??
                    (await downloadManager.fileStream(file, {
                        background: true,
                        bypassObjectURLCache: true,
                    }))!;
                res = await initiateGenerateHLS(
                    electron,
                    sourceVideo,
                    file.id,
                    fetchURL,
                    authToken,
                );
                break;
            } catch (e) {
                const retryableSourceFailure =
                    e instanceof SourcePreparationError ||
                    isNetworkDownloadError(e);
                if (retryableSourceFailure && attempt < maximumSourceAttempts) {
                    log.warn(
                        `Generate HLS for ${fileLogID(file)} | source retry ${attempt}/${maximumSourceAttempts}`,
                        e,
                    );
                    await wait(sourceRetryDelayMs);
                    continue;
                }
                throw e;
            }
        }
    } catch (e) {
        // Failures during stream generation on the native side are expected to
        // happen in two cases:
        //
        // 1. There is something specific to this video that doesn't work with
        //    the current HLS generation pipeline (the ffmpeg invocation).
        //
        // 2. The upload of the generated video fails.
        //
        // The native side code already retries failures for case 2 (except HTTP
        // 4xx errors). Thus, usually we should come here only for case 1, and
        // retrying the same video again will not work either.
        if (
            !(e instanceof JasnaUnavailableError) &&
            !(e instanceof SourcePreparationError) &&
            !isNetworkDownloadError(e)
        ) {
            await markFailedVideoFile(file);
            throw new PersistedVideoFailureError(e);
        }
        throw e;
    } finally {
        stopProgressPolling();
        clearCurrentProgress(file.id);
    }

    if (!res) {
        log.info(`Generate HLS for ${fileLogID(file)} | not-required`);
        // See: [Note: Marking files which do not need video processing]
        await updateFilePublicMagicMetadata(file, { sv: 1 });
        return;
    }

    const { playlistToken, dimensions, videoSize, videoObjectID, generator } =
        res;
    try {
        const playlist = await readVideoStream(electron, playlistToken).then(
            (res) => res.text(),
        );

        const playlistData = await encodePlaylistJSON({
            type: "hls_video",
            playlist,
            ...dimensions,
            size: videoSize,
            generator,
        });

        const encryptedPlaylist = await encryptBlob(playlistData, file.key);

        try {
            await putVideoData(
                file,
                encryptedPlaylist,
                videoObjectID,
                videoSize,
            );
        } catch (e) {
            if (isHTTP4xxError(e)) {
                await markFailedVideoFile(file);
                throw new PersistedVideoFailureError(e);
            }
            throw e;
        }

        log.info(
            `Generate HLS for ${fileLogID(file)} | done | generator=${generator}`,
        );
    } finally {
        await videoStreamDone(electron, playlistToken);
    }
};

/**
 * A semi-sibling of {@link decryptPlaylistJSON}, which does the gzip but leaves
 * the encryption up to the next layer.
 *
 * It is a trivial function, the main utility it provides is that it forces us
 * to conform to the {@link PlaylistJSON} type.
 */
const encodePlaylistJSON = (playlistJSON: PlaylistJSONType) =>
    gzip(JSON.stringify(playlistJSON));
