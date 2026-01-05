const progressByFileID = new Map<number, number>();
const clearTimers = new Map<number, NodeJS.Timeout>();

export const setFFmpegProgress = (fileID: number, progress: number) => {
    const clamped = Math.min(1, Math.max(0, progress));
    progressByFileID.set(fileID, clamped);

    const timer = clearTimers.get(fileID);
    if (timer) {
        clearTimeout(timer);
        clearTimers.delete(fileID);
    }
};

export const getFFmpegProgress = (fileID: number) =>
    progressByFileID.get(fileID);

export const scheduleClearFFmpegProgress = (
    fileID: number,
    delayMs = 15000,
) => {
    const timer = clearTimers.get(fileID);
    if (timer) clearTimeout(timer);

    clearTimers.set(
        fileID,
        setTimeout(() => {
            progressByFileID.delete(fileID);
            clearTimers.delete(fileID);
        }, delayMs),
    );
};

export const clearFFmpegProgress = (fileID?: number) => {
    if (fileID === undefined) {
        progressByFileID.clear();
        for (const timer of clearTimers.values()) {
            clearTimeout(timer);
        }
        clearTimers.clear();
        return;
    }

    progressByFileID.delete(fileID);
    const timer = clearTimers.get(fileID);
    if (timer) {
        clearTimeout(timer);
        clearTimers.delete(fileID);
    }
};
