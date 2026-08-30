import { z } from "zod";

export const PlaylistJSON = z.object({
    /** Extensible playlist format discriminator. */
    type: z.string(),
    /** HLS playlist template. */
    playlist: z.string(),
    /** Video dimensions in pixels. */
    width: z.number(),
    height: z.number(),
    /** Size in bytes of the corresponding video segments file. */
    size: z.number(),
    /** Versioned pipeline which generated the stream. */
    generator: z.string().optional(),
});

export type PlaylistJSON = z.infer<typeof PlaylistJSON>;

const recreatablePlaylistMetadataFields = new Set(["width", "height"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value == "object" && !Array.isArray(value);

export const shouldRecreateInvalidPlaylistForJasnaMigration = (
    jasnaConfigured: boolean,
    playlistJSON: unknown,
    error: unknown,
) =>
    jasnaConfigured &&
    isRecord(playlistJSON) &&
    playlistJSON.type == "hls_video" &&
    error instanceof z.ZodError &&
    error.issues.length > 0 &&
    error.issues.every(
        ({ path }) =>
            typeof path[0] == "string" &&
            recreatablePlaylistMetadataFields.has(path[0]),
    );

export const excludeFilesByID = <T extends { id: number }>(
    files: T[],
    excludedIDs: ReadonlySet<number>,
) => files.filter((file) => !excludedIDs.has(file.id));

interface RetryState {
    failures: number;
    retryAt: number;
    released: boolean;
}

export interface RecordedRetry {
    attempt: number;
    delayMs: number;
    retryAt: number;
}

/**
 * Apply bounded exponential backoff without excluding a transient failure for
 * the lifetime of the queue processor.
 */
export class TransientRetryTracker {
    private states = new Map<number, RetryState>();

    constructor(
        private initialDelayMs: number,
        private maximumDelayMs: number,
    ) {
        if (
            !Number.isFinite(initialDelayMs) ||
            initialDelayMs <= 0 ||
            !Number.isFinite(maximumDelayMs) ||
            maximumDelayMs < initialDelayMs
        ) {
            throw new RangeError("Invalid transient retry delays");
        }
    }

    recordFailure(fileID: number, now = Date.now()): RecordedRetry {
        const attempt = (this.states.get(fileID)?.failures ?? 0) + 1;
        const delayMs = Math.min(
            this.maximumDelayMs,
            this.initialDelayMs * 2 ** Math.min(attempt - 1, 30),
        );
        const retryAt = now + delayMs;
        this.states.set(fileID, {
            failures: attempt,
            retryAt,
            released: false,
        });
        return { attempt, delayMs, retryAt };
    }

    clear(fileID: number) {
        this.states.delete(fileID);
    }

    blockedFileIDs(now = Date.now()) {
        const blocked = new Set<number>();
        for (const [fileID, state] of this.states) {
            if (state.released) continue;
            if (state.retryAt > now) blocked.add(fileID);
            else state.released = true;
        }
        return blocked;
    }

    nextDelay(now = Date.now()) {
        const delays = Array.from(this.states.values())
            .filter(({ released }) => !released)
            .map(({ retryAt }) => Math.max(0, retryAt - now));
        return delays.length ? Math.min(...delays) : undefined;
    }
}

export const mapWithConcurrency = async <T, R>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>,
) => {
    if (!Number.isInteger(concurrency) || concurrency < 1)
        throw new RangeError("Concurrency must be a positive integer");

    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            results[index] = await mapper(values[index]!, index);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, worker),
    );
    return results;
};

/**
 * Inspect consecutive batches until enough candidates are found or every value
 * has been inspected. This avoids treating an empty sparse sample as an empty
 * population.
 */
export const collectCandidatesInBatches = async <T>(
    values: readonly T[],
    batchSize: number,
    maxResults: number,
    inspectBatch: (batch: readonly T[]) => Promise<readonly T[]>,
) => {
    if (!Number.isInteger(batchSize) || batchSize < 1)
        throw new RangeError("Batch size must be a positive integer");
    if (!Number.isInteger(maxResults) || maxResults < 0)
        throw new RangeError("Maximum results must be a non-negative integer");

    const results: T[] = [];
    for (
        let offset = 0;
        offset < values.length && results.length < maxResults;
        offset += batchSize
    ) {
        const remaining = maxResults - results.length;
        const candidates = await inspectBatch(
            values.slice(offset, offset + batchSize),
        );
        results.push(...candidates.slice(0, remaining));
    }
    return results;
};
