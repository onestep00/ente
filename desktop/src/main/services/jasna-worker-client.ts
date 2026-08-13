import {
    execFile,
    spawn,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import log from "../log-worker";

const jasnaPathEnvVar = "ENTE_JASNA_PATH";
const jasnaArgsEnvVar = "ENTE_JASNA_ARGS_JSON";
const startupTimeoutMs = 60 * 60 * 1000;
const statusPollIntervalMs = 500;

interface JasnaWorkerPaths {
    proxyPath: string;
    runtimeDirectory: string;
    extractorPath: string;
    installDirectory: string;
}

interface JasnaInstallManifest {
    version: 1;
    release: string;
    executable: string;
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
let installPromise: Promise<string> | undefined;
let resolvedExecutable: string | undefined;
let installRetryAfter = 0;
let lastInstallError: Error | undefined;

const execFileAsync = promisify(execFile);
const managedRelease = "v0.10.0";
const managedAssets = [
    {
        name: "jasna-windows-0.10.0.7z.001",
        size: 2_097_152_000,
        sha256: "e21e16e9d4b094f4d2a315ed5a1ed9314914e01b7e772e4b511c4e3fccaa44c5",
    },
    {
        name: "jasna-windows-0.10.0.7z.002",
        size: 2_097_152_000,
        sha256: "741d6929b490adebdc73b53b4dc98aabbbfff355cfd3295918052143b90d1045",
    },
    {
        name: "jasna-windows-0.10.0.7z.003",
        size: 36_698_772,
        sha256: "5d3cada0ca552393de0c44de7c65006d50b2b9f74d2ca43061808bc1245cd266",
    },
] as const;
const managedReleaseURL = `https://github.com/Kruk2/jasna/releases/download/${managedRelease}`;
const managedInstalledSize = 8_778_018_427;

export const initializeJasnaWorker = (paths: JasnaWorkerPaths) => {
    workerPaths = paths;
};

export const isJasnaConfigured = () =>
    process.platform == "win32" && process.arch == "x64";

const managedManifestPath = () =>
    path.join(workerPaths!.installDirectory, "current.json");

const readManagedManifest = async () => {
    try {
        return JSON.parse(
            await fs.readFile(managedManifestPath(), "utf8"),
        ) as JasnaInstallManifest;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT") return undefined;
        if (error instanceof SyntaxError) {
            log.warn("Ignoring an invalid managed Jasna manifest", error);
            return undefined;
        }
        throw error;
    }
};

const existingManagedExecutable = async () => {
    const manifest = await readManagedManifest();
    if (manifest?.version != 1 || manifest.release != managedRelease)
        return undefined;
    const executable = path.resolve(
        workerPaths!.installDirectory,
        manifest.executable,
    );
    const installPrefix = `${path.resolve(workerPaths!.installDirectory)}${path.sep}`;
    if (!executable.startsWith(installPrefix)) return undefined;
    try {
        await fs.access(executable);
        return executable;
    } catch {
        return undefined;
    }
};

const downloadAsset = async (
    destination: string,
    asset: (typeof managedAssets)[number],
) => {
    const partial = `${destination}.partial`;
    let offset = 0;
    try {
        offset = (await fs.stat(partial)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
    }
    if (offset > asset.size) {
        await fs.rm(partial, { force: true });
        offset = 0;
    }
    if (offset == asset.size) {
        if ((await fileHash(partial)) == asset.sha256) {
            await fs.rename(partial, destination);
            return;
        }
        await fs.rm(partial, { force: true });
        offset = 0;
    }
    log.info(`Downloading managed Jasna asset ${asset.name}`);
    const response = await fetch(`${managedReleaseURL}/${asset.name}`, {
        ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}),
        redirect: "follow",
    });
    if (!response.ok || !response.body)
        throw new Error(`Jasna download failed: HTTP ${response.status}`);
    if (offset && response.status != 206) {
        await fs.rm(partial, { force: true });
        return downloadAsset(destination, asset);
    }
    if (offset) {
        const contentRange = response.headers.get("content-range");
        if (!contentRange?.startsWith(`bytes ${offset}-`))
            throw new Error(`Invalid resume response for ${asset.name}`);
    }
    await pipeline(
        Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
        createWriteStream(partial, { flags: offset ? "a" : "w" }),
    );
    const stat = await fs.stat(partial);
    if (stat.size != asset.size)
        throw new Error(
            `Unexpected size for ${asset.name}: ${stat.size}/${asset.size}`,
        );
    if ((await fileHash(partial)) != asset.sha256)
        throw new Error(`Checksum mismatch for ${asset.name}`);
    await fs.rename(partial, destination);
    log.info(`Downloaded and verified managed Jasna asset ${asset.name}`);
};

const installManagedRelease = async () => {
    const paths = workerPaths;
    if (!paths) throw new Error("Jasna worker was not initialized");
    const downloadDirectory = path.join(paths.installDirectory, "downloads");
    const versionsDirectory = path.join(paths.installDirectory, "versions");
    const finalDirectory = path.join(versionsDirectory, managedRelease);
    const stagingDirectory = path.join(
        versionsDirectory,
        `${managedRelease}.installing-${randomUUID()}`,
    );
    await Promise.all([
        fs.mkdir(downloadDirectory, { recursive: true }),
        fs.mkdir(versionsDirectory, { recursive: true }),
        fs.access(paths.extractorPath),
    ]);
    const fileSystem = await fs.statfs(paths.installDirectory);
    const availableBytes = fileSystem.bavail * fileSystem.bsize;
    let downloadedBytes = 0;
    for (const asset of managedAssets) {
        for (const candidate of [
            path.join(downloadDirectory, asset.name),
            path.join(downloadDirectory, `${asset.name}.partial`),
        ]) {
            try {
                downloadedBytes += Math.min(
                    (await fs.stat(candidate)).size,
                    asset.size,
                );
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code != "ENOENT")
                    throw error;
            }
        }
    }
    const downloadSize = managedAssets.reduce(
        (sum, asset) => sum + asset.size,
        0,
    );
    const requiredBytes =
        managedInstalledSize +
        downloadSize -
        downloadedBytes +
        512 * 1024 * 1024;
    if (availableBytes < requiredBytes)
        throw new Error(
            `Not enough disk space to install Jasna: ${availableBytes}/${requiredBytes}`,
        );
    log.info(`Installing managed Jasna ${managedRelease}`);
    for (const asset of managedAssets) {
        const destination = path.join(downloadDirectory, asset.name);
        let valid = false;
        try {
            const stat = await fs.stat(destination);
            valid =
                stat.size == asset.size &&
                (await fileHash(destination)) == asset.sha256;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
        }
        if (!valid) {
            await fs.rm(destination, { force: true });
            await downloadAsset(destination, asset);
        }
    }
    await fs.mkdir(stagingDirectory, { recursive: true });
    try {
        await execFileAsync(paths.extractorPath, [
            "x",
            path.join(downloadDirectory, managedAssets[0].name),
            `-o${stagingDirectory}`,
            "-y",
        ]);
        const executable = path.join(stagingDirectory, "jasna.exe");
        await fs.access(executable);
        const replacedDirectory = `${finalDirectory}.replaced-${randomUUID()}`;
        let replacedExisting = false;
        try {
            await fs.rename(finalDirectory, replacedDirectory);
            replacedExisting = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
        }
        try {
            await fs.rename(stagingDirectory, finalDirectory);
        } catch (error) {
            if (replacedExisting)
                await fs.rename(replacedDirectory, finalDirectory);
            throw error;
        }
        await writeJSONAtomically(managedManifestPath(), {
            version: 1,
            release: managedRelease,
            executable: path.relative(
                paths.installDirectory,
                path.join(finalDirectory, "jasna.exe"),
            ),
        } satisfies JasnaInstallManifest);
        if (replacedExisting)
            await fs.rm(replacedDirectory, { recursive: true, force: true });
        await fs.rm(downloadDirectory, { recursive: true, force: true });
        log.info(`Installed managed Jasna ${managedRelease}`);
        return path.join(finalDirectory, "jasna.exe");
    } catch (error) {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
        throw error;
    }
};

const resolveExecutable = async () => {
    if (resolvedExecutable) return resolvedExecutable;
    const override = process.env[jasnaPathEnvVar]?.trim();
    if (override) {
        await fs.access(override);
        return (resolvedExecutable = override);
    }
    const existing = await existingManagedExecutable();
    if (existing) return (resolvedExecutable = existing);
    if (lastInstallError && Date.now() < installRetryAfter)
        throw lastInstallError;
    installPromise ??= installManagedRelease()
        .catch((error: unknown) => {
            const installError =
                error instanceof Error ? error : new Error(String(error));
            lastInstallError = installError;
            installRetryAfter = Date.now() + 60 * 1000;
            throw installError;
        })
        .finally(() => {
            installPromise = undefined;
        });
    resolvedExecutable = await installPromise;
    lastInstallError = undefined;
    installRetryAfter = 0;
    return resolvedExecutable;
};

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
    let executable: string;
    try {
        executable = await resolveExecutable();
    } catch (error) {
        throw new Error(`ENTE_JASNA_UNAVAILABLE: ${String(error)}`, {
            cause: error,
        });
    }
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

export const runJasnaHLSJob = async (job: JasnaJob) => {
    const previous = jobTail;
    let release!: () => void;
    jobTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
        try {
            await startWorker();
        } catch (error) {
            if (String(error).includes("ENTE_JASNA_UNAVAILABLE")) throw error;
            throw new Error(`ENTE_JASNA_UNAVAILABLE: ${String(error)}`, {
                cause: error,
            });
        }
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
