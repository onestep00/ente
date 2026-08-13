import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import log from "../log-worker";

const jasnaPathEnvVar = "ENTE_JASNA_PATH";
const jasnaArgsEnvVar = "ENTE_JASNA_ARGS_JSON";
const startupTimeoutMs = 60 * 60 * 1000;
const statusPollIntervalMs = 500;

interface JasnaWorkerPaths {
    proxyPath: string;
    runtimeDirectory: string;
}

interface JasnaJobStatus {
    version: number;
    jobId: string;
    state: "started" | "running" | "complete" | "error";
    progress?: number;
    error?: string;
}

interface JasnaJob {
    inputPath: string;
    outputDir: string;
    keyInfoPath: string;
    durationSeconds: number;
    onProgress: (progress: number) => void;
}

interface ProxyInstallManifest {
    version: 1;
    installedProxyHash: string;
}

let workerPaths: JasnaWorkerPaths | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let workerPort: number | undefined;
let readyPromise: Promise<void> | undefined;
let startingPromise: Promise<void> | undefined;
let jobTail = Promise.resolve();

export const initializeJasnaWorker = (paths: JasnaWorkerPaths) => {
    workerPaths = paths;
};

export const isJasnaConfigured = () =>
    process.platform == "win32" &&
    process.arch == "x64" &&
    Boolean(process.env[jasnaPathEnvVar]?.trim());

const configuredArgs = () => {
    const raw = process.env[jasnaArgsEnvVar]?.trim();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
        !Array.isArray(parsed) ||
        !parsed.every((arg) => typeof arg == "string")
    ) {
        throw new Error(`${jasnaArgsEnvVar} must be a JSON string array`);
    }
    const enteOwned = new Set([
        "--input",
        "--output",
        "--stream",
        "--stream-port",
        "--stream-segment-duration",
    ]);
    const conflict = parsed.find((arg) => enteOwned.has(arg));
    if (conflict)
        throw new Error(`${jasnaArgsEnvVar} cannot override ${conflict}`);
    return parsed;
};

const installProxy = async (jasnaPath: string) => {
    const paths = workerPaths;
    if (!paths) throw new Error("Jasna worker was not initialized");
    const toolsDirectory = path.join(path.dirname(jasnaPath), "tools");
    const ffmpegPath = path.join(toolsDirectory, "ffmpeg.exe");
    const realFFmpegPath = path.join(toolsDirectory, "ffmpeg.jasna.exe");
    const manifestPath = path.join(toolsDirectory, "ente-ffmpeg-proxy.json");
    await Promise.all([
        fs.access(jasnaPath),
        fs.access(paths.proxyPath),
        fs.access(ffmpegPath),
        fs.mkdir(paths.runtimeDirectory, { recursive: true }),
    ]);
    const [currentHash, proxyHash, manifest] = await Promise.all([
        fileHash(ffmpegPath),
        fileHash(paths.proxyPath),
        readProxyManifest(manifestPath),
    ]);
    const currentIsInstalledProxy =
        currentHash == proxyHash || currentHash == manifest?.installedProxyHash;
    if (!currentIsInstalledProxy) {
        await fs.copyFile(ffmpegPath, realFFmpegPath);
    } else {
        await fs.access(realFFmpegPath);
    }
    await fs.copyFile(paths.proxyPath, ffmpegPath);
    await writeJSONAtomically(manifestPath, {
        version: 1,
        installedProxyHash: proxyHash,
    } satisfies ProxyInstallManifest);
    return {
        jobPath: path.join(paths.runtimeDirectory, "current-job.json"),
        realFFmpegPath,
    };
};

const fileHash = async (filePath: string) =>
    createHash("sha256")
        .update(await fs.readFile(filePath))
        .digest("hex");

const readProxyManifest = async (manifestPath: string) => {
    try {
        const value = JSON.parse(
            await fs.readFile(manifestPath, "utf8"),
        ) as Partial<ProxyInstallManifest>;
        return value.version == 1 && typeof value.installedProxyHash == "string"
            ? (value as ProxyInstallManifest)
            : undefined;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code == "ENOENT")
            return undefined;
        throw error;
    }
};

const reservePort = () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address == "string") {
                server.close();
                reject(new Error("Could not reserve a Jasna stream port"));
                return;
            }
            server.close((error) =>
                error ? reject(error) : resolve(address.port),
            );
        });
    });

const startWorkerOnce = async () => {
    if (child && readyPromise) return readyPromise;
    const executable = process.env[jasnaPathEnvVar]?.trim();
    if (!executable) throw new Error(`${jasnaPathEnvVar} is not configured`);
    const { jobPath, realFFmpegPath } = await installProxy(executable);
    const port = await reservePort();
    const worker = spawn(
        workerPaths!.proxyPath,
        [
            "--ente-jasna-host",
            process.pid.toString(),
            "--",
            executable,
            ...configuredArgs(),
            "--stream",
            "--no-browser",
            "--stream-port",
            port.toString(),
            "--stream-segment-duration",
            "2",
            "--no-progress",
            "--log-level",
            "warning",
        ],
        {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                ENTE_JASNA_FFMPEG_JOB: jobPath,
                ENTE_JASNA_REAL_FFMPEG: realFFmpegPath,
            },
        },
    );
    child = worker;
    workerPort = port;
    readline
        .createInterface({ input: worker.stdout })
        .on("line", (line) => log.info(`[jasna] ${line}`));
    readline
        .createInterface({ input: worker.stderr })
        .on("line", (line) => log.warn(`[jasna] ${line}`));
    const exited = new Promise<never>((_, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code, signal) => {
            if (child === worker) {
                child = undefined;
                workerPort = undefined;
                readyPromise = undefined;
            }
            reject(new Error(`Jasna exited (code ${code}, signal ${signal})`));
        });
    });
    readyPromise = Promise.race([waitUntilReady(port), exited]);
    return readyPromise;
};

const startWorker = () => {
    if (child && readyPromise) return readyPromise;
    if (startingPromise) return startingPromise;
    startingPromise = startWorkerOnce()
        .catch((error: unknown) => {
            child?.kill();
            child = undefined;
            workerPort = undefined;
            readyPromise = undefined;
            throw error;
        })
        .finally(() => {
            startingPromise = undefined;
        });
    return startingPromise;
};

const waitUntilReady = async (port: number) => {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/status`);
            if (response.ok) return;
        } catch {
            // Jasna can spend 15-60 minutes compiling GPU-specific engines.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Timed out waiting for Jasna to start");
};

export const ensureJasnaWorkerReady = async () => {
    if (!isJasnaConfigured()) return false;
    await startWorker();
    return true;
};

export const runJasnaHLSJob = async (job: JasnaJob) => {
    const previous = jobTail;
    let release!: () => void;
    jobTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
        await startWorker();
        const port = workerPort;
        const runtimeDirectory = workerPaths?.runtimeDirectory;
        if (!port || !runtimeDirectory) throw new Error("Jasna did not start");
        const jobId = randomUUID();
        const jobPath = path.join(runtimeDirectory, "current-job.json");
        const statusPath = path.join(job.outputDir, "jasna-status.json");
        await writeJSONAtomically(jobPath, {
            version: 1,
            jobId,
            inputPath: job.inputPath,
            outputDir: job.outputDir,
            keyInfoPath: job.keyInfoPath,
            statusPath,
            durationSeconds: job.durationSeconds,
            segmentDuration: 2,
            minBitrate: 10_000_000,
            targetBitrate: 15_000_000,
            maxBitrate: 20_000_000,
            maxFps: 60,
        });
        try {
            const load = fetch(`http://127.0.0.1:${port}/api/load`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: job.inputPath }),
            }).then(async (response) => {
                if (!response.ok)
                    throw new Error(
                        `Jasna load failed: HTTP ${response.status} ${await response.text()}`,
                    );
            });
            await Promise.all([
                load,
                waitForJob(statusPath, jobId, job.onProgress),
            ]);
        } catch (error) {
            await stopCurrentJob(port);
            throw error;
        } finally {
            await Promise.all([
                fs.rm(jobPath, { force: true }),
                fs.rm(statusPath, { force: true }),
            ]);
        }
    } finally {
        release();
    }
};

const waitForJob = async (
    statusPath: string,
    jobId: string,
    onProgress: (progress: number) => void,
) => {
    while (true) {
        const status = await readStatus(statusPath);
        if (status?.version == 1 && status.jobId == jobId) {
            if (typeof status.progress == "number") onProgress(status.progress);
            if (status.state == "complete") return;
            if (status.state == "error")
                throw new Error(status.error ?? "Jasna FFmpeg failed");
        }
        await new Promise((resolve) =>
            setTimeout(resolve, statusPollIntervalMs),
        );
    }
};

const readStatus = async (statusPath: string) => {
    try {
        return JSON.parse(
            await fs.readFile(statusPath, "utf8"),
        ) as JasnaJobStatus;
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            (error.code == "ENOENT" || error.code == "EBUSY")
        ) {
            return undefined;
        }
        throw error;
    }
};

const stopCurrentJob = async (port: number) => {
    try {
        await fetch(`http://127.0.0.1:${port}/api/stop`, { method: "POST" });
    } catch (error) {
        log.warn("Failed to stop the current Jasna job", error);
    }
};

const writeJSONAtomically = async (filePath: string, value: unknown) => {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(value));
    await fs.rm(filePath, { force: true });
    await fs.rename(temporaryPath, filePath);
};

process.once("exit", () => child?.kill());
