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
