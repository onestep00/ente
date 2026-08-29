import { describe, expect, test, vi } from "vitest";
import {
    excludeFilesByID,
    mapWithConcurrency,
    PlaylistJSON,
    shouldRecreateInvalidPlaylistForJasnaMigration,
    TransientRetryTracker,
} from "./video-queue";

describe("shouldRecreateInvalidPlaylistForJasnaMigration", () => {
    test("recreates a Jasna HLS playlist with null dimensions", () => {
        const playlistJSON = {
            type: "hls_video",
            playlist: "#EXTM3U",
            width: null,
            height: null,
            size: 1024,
        };
        const result = PlaylistJSON.safeParse(playlistJSON);
        expect(result.success).toBe(false);
        if (result.success) return;

        expect(
            shouldRecreateInvalidPlaylistForJasnaMigration(
                true,
                playlistJSON,
                result.error,
            ),
        ).toBe(true);
    });

    test("does not overwrite an unrecognized playlist envelope", () => {
        const playlistJSON = {
            type: "future_video",
            playlist: "future payload",
            width: null,
            height: null,
            size: 1024,
        };
        const result = PlaylistJSON.safeParse(playlistJSON);
        expect(result.success).toBe(false);
        if (result.success) return;

        expect(
            shouldRecreateInvalidPlaylistForJasnaMigration(
                true,
                playlistJSON,
                result.error,
            ),
        ).toBe(false);
    });

    test("does not recreate for non-schema or non-Jasna failures", () => {
        const playlistJSON = {
            type: "hls_video",
            playlist: "#EXTM3U",
            width: null,
            height: null,
            size: 1024,
        };
        const result = PlaylistJSON.safeParse(playlistJSON);
        expect(result.success).toBe(false);
        if (result.success) return;

        expect(
            shouldRecreateInvalidPlaylistForJasnaMigration(
                false,
                playlistJSON,
                result.error,
            ),
        ).toBe(false);
        expect(
            shouldRecreateInvalidPlaylistForJasnaMigration(
                true,
                playlistJSON,
                new Error("network failure"),
            ),
        ).toBe(false);
    });

    test("does not recreate when non-dimension fields are invalid", () => {
        const playlistJSON = {
            type: "hls_video",
            playlist: null,
            width: null,
            height: null,
            size: 1024,
        };
        const result = PlaylistJSON.safeParse(playlistJSON);
        expect(result.success).toBe(false);
        if (result.success) return;

        expect(
            shouldRecreateInvalidPlaylistForJasnaMigration(
                true,
                playlistJSON,
                result.error,
            ),
        ).toBe(false);
    });
});

test("excludeFilesByID removes attempted and active backfill files", () => {
    const files = [{ id: 1 }, { id: 2 }, { id: 3 }];

    expect(excludeFilesByID(files, new Set([1, 3]))).toEqual([{ id: 2 }]);
});

test("mapWithConcurrency bounds active work and preserves result order", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: (() => void)[] = [];
    const mapper = async (value: number) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return value * 2;
    };

    const result = mapWithConcurrency([1, 2, 3, 4, 5], 2, mapper);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();

    await expect(result).resolves.toEqual([2, 4, 6, 8, 10]);
    expect(maximumActive).toBe(2);
});

test("mapWithConcurrency rejects an invalid limit", async () => {
    await expect(
        mapWithConcurrency([1], 0, (value) => Promise.resolve(value)),
    ).rejects.toThrow("Concurrency must be a positive integer");
});

test("TransientRetryTracker retries after bounded exponential backoff", () => {
    const retries = new TransientRetryTracker(100, 400);

    expect(retries.recordFailure(1, 1_000)).toEqual({
        attempt: 1,
        delayMs: 100,
        retryAt: 1_100,
    });
    expect(retries.blockedFileIDs(1_099)).toEqual(new Set([1]));
    expect(retries.blockedFileIDs(1_100)).toEqual(new Set());

    expect(retries.recordFailure(1, 1_100).delayMs).toBe(200);
    expect(retries.recordFailure(1, 1_300).delayMs).toBe(400);
    expect(retries.recordFailure(1, 1_700).delayMs).toBe(400);
    expect(retries.nextDelay(1_800)).toBe(300);

    retries.clear(1);
    expect(retries.blockedFileIDs(1_800)).toEqual(new Set());
    expect(retries.nextDelay(1_800)).toBeUndefined();
    expect(retries.recordFailure(1, 2_000).attempt).toBe(1);
});

test("TransientRetryTracker wakes for the earliest pending retry", () => {
    const retries = new TransientRetryTracker(100, 400);
    retries.recordFailure(1, 1_000);
    retries.recordFailure(2, 1_050);

    expect(retries.nextDelay(1_075)).toBe(25);
    expect(retries.blockedFileIDs(1_100)).toEqual(new Set([2]));
});

test("TransientRetryTracker wakes immediately if a retry expires during discovery", () => {
    const retries = new TransientRetryTracker(100, 400);
    retries.recordFailure(1, 1_000);

    expect(retries.blockedFileIDs(1_099)).toEqual(new Set([1]));
    expect(retries.nextDelay(1_101)).toBe(0);

    expect(retries.blockedFileIDs(1_101)).toEqual(new Set());
    expect(retries.nextDelay(1_101)).toBeUndefined();
});
