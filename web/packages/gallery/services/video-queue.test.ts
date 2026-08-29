import { describe, expect, test, vi } from "vitest";
import {
    excludeFilesByID,
    mapWithConcurrency,
    PlaylistJSON,
    shouldRecreateInvalidPlaylistForJasnaMigration,
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
