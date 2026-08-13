import type { ZipItem } from "../../types/ipc";
import {
    deleteTempFileIgnoringErrors,
    makeFileForStreamOrPathOrZipItem,
} from "../utils/temp";

export type SeekableVideoInput = ReadableStream | string | ZipItem;

/** A filesystem path that stays valid until {@link release} completes. */
export interface SeekableVideoInputLease {
    path: string;
    prepare: () => Promise<void>;
    release: () => Promise<void>;
}

/**
 * Presents video input as a seekable filesystem path.
 *
 * The default implementation materializes streams and zip entries on disk.
 * A future virtual filesystem can implement this contract without changing
 * the video processing pipeline.
 */
export interface SeekableVideoInputProvider {
    acquire: (input: SeekableVideoInput) => Promise<SeekableVideoInputLease>;
}

export class DiskSeekableVideoInputProvider
    implements SeekableVideoInputProvider
{
    async acquire(input: SeekableVideoInput) {
        const temporary = await makeFileForStreamOrPathOrZipItem(input);
        return {
            path: temporary.path,
            prepare: temporary.writeToTemporaryFile,
            release: temporary.isFileTemporary
                ? () => deleteTempFileIgnoringErrors(temporary.path)
                : () => Promise.resolve(),
        };
    }
}

let provider: SeekableVideoInputProvider = new DiskSeekableVideoInputProvider();

export const acquireSeekableVideoInput = (input: SeekableVideoInput) =>
    provider.acquire(input);

/** Replace the provider when a dedicated seekable temporary filesystem exists. */
export const setSeekableVideoInputProvider = (
    replacement: SeekableVideoInputProvider,
) => {
    provider = replacement;
};
