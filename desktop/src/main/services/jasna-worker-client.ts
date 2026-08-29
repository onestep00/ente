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
const jasnaFirewallRuleName = "Ente managed Jasna local-only";
const startupTimeoutMs = 60 * 60 * 1000;
const statusPollIntervalMs = 250;
const jobStallTimeoutMs = 2 * 60 * 1000;
const heartbeatTimeoutMs = 5 * 1000;
const maximumJobTimeoutMs = 24 * 60 * 60 * 1000;
const maximumJobAttempts = 2;
const jasnaConfigEnvVar = "ENTE_JASNA_CONFIG";

const defaultJasnaConfig = {
    generator: "jasna-ente-v5",
    batchSize: 16,
    maxClipSize: 2880,
    temporalOverlap: 15,
    fp16: true,
    compileBasicVSRPP: true,
    enableCrossfade: true,
    detectionModel: "rfdetr-v6",
    detectionScoreThreshold: 0.15,
    secondaryRestoration: "unet-4x",
    primaryClipBatchSize: "auto",
    streamWorkers: "auto",
    logLevel: "warning",
    extraArgs: [] as string[],
} as const;

interface JasnaConfig {
    generator: string;
    batchSize: number;
    maxClipSize: number;
    temporalOverlap: number;
    fp16: boolean;
    compileBasicVSRPP: boolean;
    enableCrossfade: boolean;
    detectionModel: string;
    detectionScoreThreshold: number;
    secondaryRestoration: string;
    primaryClipBatchSize: string;
    streamWorkers: string;
    logLevel: "error" | "warning" | "info" | "debug";
    extraArgs: string[];
}

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
    fileID: number;
    inputPath: string;
    outputDir: string;
    keyInfoPath: string;
    durationSeconds: number;
    fps: number | undefined;
    onProgress: (progress: number) => void;
}

interface ProxyInstallManifest {
    version: 1;
    installedProxyHash: string;
}

interface ManagedAsset {
    name: string;
    size: number;
    sha256: string;
    downloadURL?: string;
}

let workerPaths: JasnaWorkerPaths | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let workerPort: number | undefined;
let readyPromise: Promise<void> | undefined;
let startingPromise: Promise<void> | undefined;
let legacyJobTail = Promise.resolve();
let installPromise: Promise<string> | undefined;
let resolvedExecutable: string | undefined;
let installRetryAfter = 0;
let lastInstallError: Error | undefined;
let firewalledExecutable: string | undefined;
let workerSupportsDynamicJobs = false;

type JasnaJobFailureKind = "source" | "worker";

/**
 * A failure reported by a Jasna pipeline thread. Jasna v0.10 can keep its
 * HTTP server and heartbeat alive after a pipeline thread has crashed, so the
 * desktop client must surface these failures independently of /status.
 */
class JasnaJobFailure extends Error {
    constructor(
        readonly kind: JasnaJobFailureKind,
        message: string,
    ) {
        super(message);
        this.name = "JasnaJobFailure";
    }
}

interface ActiveJasnaJob {
    inputPath: string;
    armed: boolean;
    reject: (error: JasnaJobFailure) => void;
}

/** Active jobs sharing the persistent Jasna worker. */
const activeJasnaJobs = new Map<string, ActiveJasnaJob>();

interface JobCompletion {
    recoveredFromOutput: boolean;
}

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
] as const satisfies readonly ManagedAsset[];
const managedReleaseURL = `https://github.com/Kruk2/jasna/releases/download/${managedRelease}`;
const managedInstalledSize = 8_778_018_427;

const jasnaFailureKind = (line: string): JasnaJobFailureKind | undefined => {
    const lower = line.toLowerCase();

    // These messages are emitted after Jasna has exhausted its corrupt-packet
    // tolerance. Individual NAL warnings are intentionally ignored because a
    // decoder may recover from an isolated bad packet.
    if (lower.includes("videodecodeerror") || lower.includes("corrupt_data"))
        return "source";

    if (
        lower.includes("pipeline_threads error") &&
        lower.includes("thread crashed")
    )
        return lower.includes("[decode]") ? "source" : "worker";

    if (
        lower.includes("cuda out of memory") ||
        lower.includes("outofmemoryerror")
    )
        return "worker";

    return undefined;
};

const reportJasnaFailure = (line: string) => {
    const kind = jasnaFailureKind(line);
    if (!kind) return;

    const armedJobs = [...activeJasnaJobs.entries()].filter(
        ([, job]) => job.armed,
    );
    if (armedJobs.length === 0) return;

    // VideoDecodeError includes the input path. Prefer that match so one bad
    // source does not mask an unrelated job when the worker supports dynamic
    // jobs. Unscoped worker failures are broadcast because the shared worker
    // must be restarted before any of its jobs can safely continue.
    const matchingJobs = armedJobs.filter(([, job]) =>
        line.includes(job.inputPath),
    );
    const affectedJobs = matchingJobs.length ? matchingJobs : armedJobs;
    const error = new JasnaJobFailure(
        kind,
        `Jasna ${kind} failure reported by worker: ${line}`,
    );
    for (const [, job] of affectedJobs) job.reject(error);
};

export const initializeJasnaWorker = (paths: JasnaWorkerPaths) => {
    workerPaths = paths;
};

export const isJasnaConfigured = () =>
    process.platform == "win32" && process.arch == "x64";

const jasnaConfigPath = () => {
    const override = process.env[jasnaConfigEnvVar]?.trim();
    if (override) return path.resolve(override);
    if (!workerPaths) throw new Error("Jasna worker was not initialized");
    return path.join(workerPaths.installDirectory, "config.json");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value == "object" && !Array.isArray(value);

const assertConfigString = (value: unknown, name: string) => {
    if (typeof value != "string" || !value.trim())
        throw new Error(`Jasna config ${name} must be a non-empty string`);
    return value.trim();
};

const assertConfigGenerator = (value: unknown) => {
    const generator = assertConfigString(value, "generator");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(generator))
        throw new Error(
            "Jasna config generator must contain only letters, numbers, dots, underscores, or hyphens",
        );
    return generator;
};

const assertConfigInteger = (
    value: unknown,
    name: string,
    minimum: number,
    maximum: number,
) => {
    if (
        typeof value != "number" ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum
    )
        throw new Error(
            `Jasna config ${name} must be an integer in [${minimum}, ${maximum}]`,
        );
    return value;
};

const assertConfigNumber = (
    value: unknown,
    name: string,
    minimum: number,
    maximum: number,
) => {
    if (
        typeof value != "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum
    )
        throw new Error(
            `Jasna config ${name} must be a number in [${minimum}, ${maximum}]`,
        );
    return value;
};

const assertConfigBoolean = (value: unknown, name: string) => {
    if (typeof value != "boolean")
        throw new Error(`Jasna config ${name} must be a boolean`);
    return value;
};

const assertConfigWorkerValue = (value: unknown, name: string) => {
    if (typeof value != "string" || !/^(auto|[1-9][0-9]*)$/.test(value.trim()))
        throw new Error(
            `Jasna config ${name} must be "auto" or a positive integer string`,
        );
    return value.trim();
};

const assertConfigLogLevel = (value: unknown): JasnaConfig["logLevel"] => {
    if (
        value != "error" &&
        value != "warning" &&
        value != "info" &&
        value != "debug"
    )
        throw new Error(
            "Jasna config logLevel must be one of error, warning, info, or debug",
        );
    return value as JasnaConfig["logLevel"];
};

const validateJasnaExtraArgs = (value: unknown) => {
    if (!Array.isArray(value) || !value.every((arg) => typeof arg == "string"))
        throw new Error("Jasna config extraArgs must be a string array");
    const enteOwned = new Set([
        "--input",
        "--output",
        "--stream",
        "--stream-port",
        "--stream-segment-duration",
        "--batch-size",
        "--max-clip-size",
        "--temporal-overlap",
        "--fp16",
        "--no-fp16",
        "--compile-basicvsrpp",
        "--no-compile-basicvsrpp",
        "--enable-crossfade",
        "--no-enable-crossfade",
        "--detection-model",
        "--detection-score-threshold",
        "--secondary-restoration",
        "--log-level",
        "--primary-clip-batch-size",
        "--stream-workers",
    ]);
    for (const arg of value) {
        const option = arg.trim().split("=", 1)[0] ?? "";
        if (enteOwned.has(option))
            throw new Error(`Jasna config extraArgs cannot override ${option}`);
    }
    return [...value] as string[];
};

const readJasnaConfig = async (): Promise<JasnaConfig> => {
    const configPath = jasnaConfigPath();
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code != "ENOENT") {
            throw new Error(`Could not read Jasna config ${configPath}`, {
                cause: error,
            });
        }
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(
            configPath,
            `${JSON.stringify(defaultJasnaConfig, undefined, 2)}\n`,
            "utf8",
        );
        log.info(`Created default Jasna config at ${configPath}`);
        return { ...defaultJasnaConfig, extraArgs: [] };
    }

    if (!isRecord(parsed))
        throw new Error(
            `Jasna config ${configPath} must contain a JSON object`,
        );
    const legacyManagedConfig =
        parsed.generator == "jasna-ente-v5" &&
        parsed.batchSize == 16 &&
        parsed.maxClipSize == 600 &&
        parsed.temporalOverlap == 15 &&
        parsed.detectionModel == "rfdetr-v6" &&
        parsed.detectionScoreThreshold == 0.15 &&
        parsed.secondaryRestoration == "unet-4x" &&
        parsed.logLevel === undefined;
    const candidate = {
        ...defaultJasnaConfig,
        ...parsed,
        extraArgs: parsed.extraArgs ?? defaultJasnaConfig.extraArgs,
        ...(legacyManagedConfig
            ? {
                  batchSize: defaultJasnaConfig.batchSize,
                  maxClipSize: defaultJasnaConfig.maxClipSize,
                  logLevel: defaultJasnaConfig.logLevel,
              }
            : {}),
    };
    const config: JasnaConfig = {
        generator: assertConfigGenerator(candidate.generator),
        batchSize: assertConfigInteger(candidate.batchSize, "batchSize", 1, 64),
        maxClipSize: assertConfigInteger(
            candidate.maxClipSize,
            "maxClipSize",
            30,
            3600,
        ),
        temporalOverlap: assertConfigInteger(
            candidate.temporalOverlap,
            "temporalOverlap",
            0,
            120,
        ),
        fp16: assertConfigBoolean(candidate.fp16, "fp16"),
        compileBasicVSRPP: assertConfigBoolean(
            candidate.compileBasicVSRPP,
            "compileBasicVSRPP",
        ),
        enableCrossfade: assertConfigBoolean(
            candidate.enableCrossfade,
            "enableCrossfade",
        ),
        detectionModel: assertConfigString(
            candidate.detectionModel,
            "detectionModel",
        ),
        detectionScoreThreshold: assertConfigNumber(
            candidate.detectionScoreThreshold,
            "detectionScoreThreshold",
            0,
            1,
        ),
        secondaryRestoration: assertConfigString(
            candidate.secondaryRestoration,
            "secondaryRestoration",
        ),
        primaryClipBatchSize: assertConfigWorkerValue(
            candidate.primaryClipBatchSize,
            "primaryClipBatchSize",
        ),
        streamWorkers: assertConfigWorkerValue(
            candidate.streamWorkers,
            "streamWorkers",
        ),
        logLevel: assertConfigLogLevel(candidate.logLevel),
        extraArgs: validateJasnaExtraArgs(candidate.extraArgs),
    };
    if (config.temporalOverlap * 2 >= config.maxClipSize)
        throw new Error(
            "Jasna config temporalOverlap must be less than half of maxClipSize",
        );
    log.info(`Loaded Jasna config from ${configPath}`);
    if (legacyManagedConfig) {
        await fs.writeFile(
            configPath,
            `${JSON.stringify(config, undefined, 2)}\n`,
            "utf8",
        );
        log.info(
            `Migrated legacy Jasna config to tuned defaults at ${configPath}`,
        );
    }
    return config;
};

export const getJasnaGenerator = async () =>
    (await readJasnaConfig()).generator;

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

const downloadAsset = async (destination: string, asset: ManagedAsset) => {
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
    const response = await fetch(
        asset.downloadURL ?? `${managedReleaseURL}/${asset.name}`,
        {
            ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}),
            redirect: "follow",
        },
    );
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

const configuredArgs = (supportsDynamicJobs: boolean, config: JasnaConfig) => {
    const raw = process.env[jasnaArgsEnvVar]?.trim();
    const defaults = [
        "--batch-size",
        config.batchSize.toString(),
        "--max-clip-size",
        config.maxClipSize.toString(),
        "--temporal-overlap",
        config.temporalOverlap.toString(),
        config.fp16 ? "--fp16" : "--no-fp16",
        config.compileBasicVSRPP
            ? "--compile-basicvsrpp"
            : "--no-compile-basicvsrpp",
        config.enableCrossfade ? "--enable-crossfade" : "--no-enable-crossfade",
        "--detection-model",
        config.detectionModel,
        "--detection-score-threshold",
        config.detectionScoreThreshold.toString(),
        "--secondary-restoration",
        config.secondaryRestoration,
        "--log-level",
        config.logLevel,
        ...(supportsDynamicJobs
            ? [
                  "--primary-clip-batch-size",
                  config.primaryClipBatchSize,
                  "--stream-workers",
                  config.streamWorkers,
              ]
            : []),
        ...config.extraArgs,
    ];
    if (!raw) return defaults;
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
        "--batch-size",
        "--max-clip-size",
        "--temporal-overlap",
        "--fp16",
        "--no-fp16",
        "--compile-basicvsrpp",
        "--no-compile-basicvsrpp",
        "--enable-crossfade",
        "--no-enable-crossfade",
        "--detection-model",
        "--detection-score-threshold",
        "--secondary-restoration",
        "--log-level",
        "--primary-clip-batch-size",
        "--stream-workers",
    ]);
    const conflict = parsed.find((arg) =>
        enteOwned.has(arg.trim().split("=", 1)[0] ?? ""),
    );
    if (conflict)
        throw new Error(`${jasnaArgsEnvVar} cannot override ${conflict}`);
    return [...defaults, ...parsed];
};

const supportsDynamicJobs = async (executable: string) => {
    try {
        const { stdout } = await execFileAsync(executable, ["--help"], {
            timeout: 30_000,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        });
        return (
            stdout.includes("--stream-workers") &&
            stdout.includes("--primary-clip-batch-size")
        );
    } catch (error) {
        log.warn(
            "Could not inspect Jasna capabilities; using legacy mode",
            error,
        );
        return false;
    }
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
    const jobsDirectory = path.join(paths.runtimeDirectory, "jobs");
    await fs.mkdir(jobsDirectory, { recursive: true });
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
    return { jobsDirectory, realFFmpegPath };
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
    await ensureInboundBlocked(executable);
    workerSupportsDynamicJobs = await supportsDynamicJobs(executable);
    const config = await readJasnaConfig();
    const { jobsDirectory, realFFmpegPath } = await installProxy(executable);
    const port = await reservePort();
    const args = configuredArgs(workerSupportsDynamicJobs, config);
    log.info(
        `Starting Jasna ${path.basename(executable)} with ${JSON.stringify({
            generator: config.generator,
            batchSize: config.batchSize,
            maxClipSize: config.maxClipSize,
            temporalOverlap: config.temporalOverlap,
            detectionModel: config.detectionModel,
            detectionScoreThreshold: config.detectionScoreThreshold,
            secondaryRestoration: config.secondaryRestoration,
            logLevel: config.logLevel,
            supportsDynamicJobs: workerSupportsDynamicJobs,
            args,
        })}`,
    );
    const worker = spawn(
        workerPaths!.proxyPath,
        [
            "--ente-jasna-host",
            process.pid.toString(),
            "--",
            executable,
            ...args,
            "--stream",
            "--no-browser",
            "--stream-port",
            port.toString(),
            "--stream-segment-duration",
            "2",
            "--no-progress",
        ],
        {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                ENTE_JASNA_FFMPEG_JOB: jobsDirectory,
                ENTE_JASNA_REAL_FFMPEG: realFFmpegPath,
            },
        },
    );
    child = worker;
    workerPort = port;
    readline.createInterface({ input: worker.stdout }).on("line", (line) => {
        log.info(`[jasna] ${line}`);
        reportJasnaFailure(line);
    });
    readline.createInterface({ input: worker.stderr }).on("line", (line) => {
        log.warn(`[jasna] ${line}`);
        reportJasnaFailure(line);
    });
    const exited = new Promise<never>((_, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code, signal) => {
            if (child === worker) {
                child = undefined;
                workerPort = undefined;
                readyPromise = undefined;
                workerSupportsDynamicJobs = false;
            }
            reject(new Error(`Jasna exited (code ${code}, signal ${signal})`));
        });
    });
    readyPromise = Promise.race([waitUntilReady(port), exited]);
    return readyPromise;
};

const ensureInboundBlocked = async (executable: string) => {
    if (firewalledExecutable == executable) return;
    const checkScript = [
        `$rule = Get-NetFirewallRule -DisplayName '${jasnaFirewallRuleName}' -ErrorAction SilentlyContinue`,
        "$filter = $rule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Get-NetFirewallApplicationFilter",
        `if ($filter.Program -ine '${powershellLiteral(executable)}') { exit 1 }`,
    ].join("; ");
    try {
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            checkScript,
        ]);
    } catch {
        const installScript = [
            "$ErrorActionPreference = 'Stop'",
            `$ruleName = '${jasnaFirewallRuleName}'`,
            `Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
            `New-NetFirewallRule -DisplayName $ruleName -Description 'Block non-loopback inbound access to the Jasna worker managed by Ente.' -Direction Inbound -Action Block -Program '${powershellLiteral(executable)}' -Protocol TCP -Profile Any -Enabled True | Out-Null`,
        ].join("; ");
        const encoded = Buffer.from(installScript, "utf16le").toString(
            "base64",
        );
        const elevateScript = [
            `$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'`,
            `$process = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru`,
            "exit $process.ExitCode",
        ].join("; ");
        await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", elevateScript],
            { timeout: 2 * 60 * 1000, windowsHide: false },
        );
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            checkScript,
        ]);
    }
    firewalledExecutable = executable;
};

const powershellLiteral = (value: string) => value.replaceAll("'", "''");

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

const stopWorker = async () => {
    const worker = child;
    child = undefined;
    workerPort = undefined;
    readyPromise = undefined;
    startingPromise = undefined;
    workerSupportsDynamicJobs = false;
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => worker.once("exit", resolve));
    worker.kill();
    await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
};

const isTransientFileAccessError = (error: unknown) => {
    if (!error || typeof error != "object" || !("code" in error)) return false;
    const code = error.code;
    return code == "EBUSY" || code == "EPERM" || code == "EACCES";
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

const runJasnaHLSJobUnlocked = async (job: JasnaJob) => {
    log.info(`Jasna HLS queued for file ${job.fileID}`);
    log.info(`Jasna HLS started for file ${job.fileID}`);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumJobAttempts; attempt++) {
        try {
            const completion = await runJasnaHLSAttempt(job);
            if (completion.recoveredFromOutput) {
                log.warn(
                    "Jasna FFmpeg completed without publishing status; keeping the ready worker",
                );
            }
            return;
        } catch (error) {
            lastError = error;
            log.warn(
                `Jasna HLS attempt ${attempt}/${maximumJobAttempts} failed`,
                error,
            );
            const jasnaFailure =
                error instanceof JasnaJobFailure ? error : undefined;
            // A failed attempt can leave Jasna's internal queues or threads in
            // a broken state even when its HTTP server is still responding.
            // Always restart the worker before the next attempt; this is also
            // what releases a model that would otherwise sit idle in VRAM.
            await stopWorker();
            if (String(error).includes("ENTE_JASNA_UNAVAILABLE")) throw error;
            // A corrupt source is deterministic. Retrying the same materialized
            // bytes only burns GPU time and can leave the queue stuck, so let
            // the renderer mark this file failed and continue with the queue.
            if (jasnaFailure?.kind == "source") {
                log.warn(
                    `Skipping file ${job.fileID} after Jasna rejected its source`,
                    error,
                );
                throw error;
            }
            if (attempt < maximumJobAttempts)
                await clearJobOutput(job.outputDir);
        }
    }
    // Source failures return above. Exhausting retries for every other failure
    // means the shared worker is unavailable, not that the video is bad. Mark
    // it explicitly so the renderer retries the file after a cooldown instead
    // of persisting a false source failure.
    throw new Error(`ENTE_JASNA_UNAVAILABLE: ${String(lastError)}`, {
        cause: lastError,
    });
};

export const runJasnaHLSJob = async (job: JasnaJob) => {
    await startWorker();
    if (workerSupportsDynamicJobs) return runJasnaHLSJobUnlocked(job);

    const previous = legacyJobTail;
    let release!: () => void;
    legacyJobTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
        await runJasnaHLSJobUnlocked(job);
    } finally {
        release();
    }
};

const runJasnaHLSAttempt = async (job: JasnaJob): Promise<JobCompletion> => {
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
    const activeWorker = child;
    if (!port || !runtimeDirectory || !activeWorker)
        throw new Error("Jasna did not start");
    const jobId = randomUUID();
    const jobsDirectory = path.join(runtimeDirectory, "jobs");
    await fs.mkdir(jobsDirectory, { recursive: true });
    const jobPath = path.join(jobsDirectory, `${jobId}.json`);
    const statusPath = path.join(job.outputDir, "jasna-status.json");
    const heartbeatPath = `${statusPath}.heartbeat`;
    const controller = new AbortController();
    await clearJobOutput(job.outputDir);
    await writeJSONAtomically(jobPath, {
        version: 1,
        jobId,
        inputPath: job.inputPath,
        outputDir: job.outputDir,
        keyInfoPath: job.keyInfoPath,
        statusPath,
        durationSeconds: job.durationSeconds,
        sourceFps: job.fps,
        segmentDuration: 2,
        minBitrate: 4_000_000,
        targetBitrate: 6_000_000,
        maxBitrate: 8_000_000,
        maxFps: 60,
    });
    try {
        let rejectFatalFailure!: (error: JasnaJobFailure) => void;
        const fatalFailure = new Promise<never>((_, reject) => {
            rejectFatalFailure = reject;
        });
        activeJasnaJobs.set(jobId, {
            inputPath: job.inputPath,
            armed: false,
            reject: rejectFatalFailure,
        });
        let removeExitListener = () => undefined;
        const workerExit = new Promise<never>((_, reject) => {
            const onExit = (
                code: number | null,
                signal: NodeJS.Signals | null,
            ) =>
                reject(
                    new Error(
                        `Jasna worker exited during the job (${code ?? signal ?? "unknown"})`,
                    ),
                );
            activeWorker.once("exit", onExit);
            removeExitListener = () => {
                activeWorker.off("exit", onExit);
            };
        });
        const loadFailure = fetch(`http://127.0.0.1:${port}/api/load`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: job.inputPath, jobId }),
            signal: controller.signal,
        }).then(async (response) => {
            if (!response.ok)
                throw new Error(
                    `Jasna load failed: HTTP ${response.status} ${await response.text()}`,
                );
            const activeJob = activeJasnaJobs.get(jobId);
            if (activeJob) activeJob.armed = true;
            return new Promise<never>(() => undefined);
        });
        try {
            return await Promise.race([
                waitForJob(job, statusPath, jobId),
                loadFailure,
                workerExit,
                fatalFailure,
            ]);
        } finally {
            removeExitListener();
        }
    } catch (error) {
        await stopCurrentJob(port, jobId);
        throw error;
    } finally {
        controller.abort();
        try {
            await Promise.all([
                removeFileWithTransientRetry(jobPath),
                removeFileWithTransientRetry(statusPath),
                removeFileWithTransientRetry(heartbeatPath),
            ]);
        } finally {
            activeJasnaJobs.delete(jobId);
        }
    }
};

const waitForJob = async (
    job: JasnaJob,
    statusPath: string,
    jobId: string,
): Promise<JobCompletion> => {
    const deadline =
        Date.now() +
        Math.min(
            maximumJobTimeoutMs,
            Math.max(30 * 60 * 1000, job.durationSeconds * 20 * 1000),
        );
    let lastJobActivity = Date.now();
    let lastProgress = -1;
    let lastOutputSize = -1;
    let lastHeartbeat = 0;
    while (true) {
        const status = await readStatus(statusPath);
        if (status?.version == 1 && status.jobId == jobId) {
            if (
                typeof status.progress == "number" &&
                status.progress > lastProgress
            ) {
                lastProgress = status.progress;
                lastJobActivity = Date.now();
                job.onProgress(status.progress);
            }
            if (status.state == "complete") {
                await validateCompletedOutput(job);
                job.onProgress(1);
                return { recoveredFromOutput: false };
            }
            if (status.state == "error") {
                const message = status.error ?? "Jasna FFmpeg failed";
                throw new JasnaJobFailure(
                    /corrupt|decode|nal/i.test(message) ? "source" : "worker",
                    message,
                );
            }
        }
        const outputSize = await fileSize(
            path.join(job.outputDir, "output.ts"),
        );
        if (outputSize > lastOutputSize) {
            lastOutputSize = outputSize;
            lastJobActivity = Date.now();
        }
        const heartbeat = await fileModifiedTime(`${statusPath}.heartbeat`);
        if (heartbeat > lastHeartbeat) {
            lastHeartbeat = heartbeat;
        }
        if (await completedOutputIsValid(job)) {
            await fs
                .rm(path.join(job.outputDir, "output.ts.tmp"), { force: true })
                .catch((error: unknown) =>
                    log.warn(
                        "Could not remove completed Jasna temp output",
                        error,
                    ),
                );
            job.onProgress(1);
            return { recoveredFromOutput: true };
        }
        if (Date.now() >= deadline) throw new Error("Jasna job timed out");
        const now = Date.now();
        if (lastHeartbeat > 0 && now - lastHeartbeat >= heartbeatTimeoutMs)
            throw new Error("Jasna FFmpeg heartbeat stopped for 5 seconds");
        if (now - lastJobActivity >= jobStallTimeoutMs)
            throw new Error("Jasna job made no progress for 2 minutes");
        await new Promise((resolve) =>
            setTimeout(resolve, statusPollIntervalMs),
        );
    }
};

const completedOutputIsValid = async (job: JasnaJob) => {
    try {
        await validateCompletedOutput(job);
        return true;
    } catch (error) {
        if (
            (error as NodeJS.ErrnoException).code == "ENOENT" ||
            isTransientFileAccessError(error)
        )
            return false;
        if (
            String(error).includes("is not complete") ||
            String(error).includes("byte ranges exceed")
        )
            return false;
        throw error;
    }
};

const validateCompletedOutput = async (job: JasnaJob) => {
    const playlist = await fs.readFile(
        path.join(job.outputDir, "output.m3u8"),
        "utf8",
    );
    const outputSize = await fileSize(path.join(job.outputDir, "output.ts"));
    validateJasnaHLSPlaylist(playlist, job.durationSeconds, outputSize);
};

export const validateJasnaHLSPlaylist = (
    playlist: string,
    expectedDuration: number,
    outputSize: number,
) => {
    const lines = playlist.split(/\r?\n/);
    if (lines[0] != "#EXTM3U")
        throw new Error("Jasna HLS playlist is missing #EXTM3U");
    if (!lines.includes("#EXT-X-ENDLIST"))
        throw new Error("Jasna HLS output is not complete");
    const durations = [...playlist.matchAll(/^#EXTINF:([0-9.]+),/gm)].map(
        (match) => Number(match[1]),
    );
    if (!durations.length || durations.some((duration) => !duration))
        throw new Error("Jasna HLS playlist has invalid segment durations");
    const outputDuration = durations.reduce(
        (sum, duration) => sum + duration,
        0,
    );
    const durationTolerance = Math.max(4, expectedDuration * 0.02);
    if (Math.abs(outputDuration - expectedDuration) > durationTolerance)
        throw new Error(
            `Jasna HLS duration mismatch: ${outputDuration.toFixed(3)}/${expectedDuration.toFixed(3)} seconds`,
        );
    if (outputSize <= 0) throw new Error("Jasna HLS output is empty");
    const ranges = [...playlist.matchAll(/^#EXT-X-BYTERANGE:(\d+)@(\d+)$/gm)];
    if (!ranges.length)
        throw new Error("Jasna HLS playlist has no byte ranges");
    if (ranges.length != durations.length)
        throw new Error("Jasna HLS segment and byte-range counts differ");
    let previousEnd = 0;
    for (const [index, match] of ranges.entries()) {
        const length = Number(match[1]);
        const offset = Number(match[2]);
        if (
            !Number.isSafeInteger(length) ||
            !Number.isSafeInteger(offset) ||
            length <= 0 ||
            offset < 0 ||
            offset < previousEnd ||
            offset + length > outputSize
        )
            throw new Error(
                `Jasna HLS byte range ${index} is invalid or exceeds the output size`,
            );
        previousEnd = offset + length;
    }
};

const fileSize = async (filePath: string) => {
    try {
        return (await fs.stat(filePath)).size;
    } catch (error) {
        if (
            (error as NodeJS.ErrnoException).code == "ENOENT" ||
            isTransientFileAccessError(error)
        )
            return 0;
        throw error;
    }
};

const fileModifiedTime = async (filePath: string) => {
    try {
        return (await fs.stat(filePath)).mtimeMs;
    } catch (error) {
        if (
            (error as NodeJS.ErrnoException).code == "ENOENT" ||
            isTransientFileAccessError(error)
        )
            return 0;
        throw error;
    }
};

const clearJobOutput = async (outputDir: string) => {
    for (const name of [
        "output.m3u8",
        "output.ts",
        "output.ts.tmp",
        "jasna-status.json",
        "jasna-status.json.heartbeat",
    ]) {
        await removeFileWithTransientRetry(path.join(outputDir, name));
    }
};

const removeFileWithTransientRetry = async (filePath: string) => {
    for (let attempt = 0; ; attempt++) {
        try {
            await fs.rm(filePath, { force: true });
            return;
        } catch (error) {
            if (!isTransientFileAccessError(error) || attempt >= 9) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
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
            (error.code == "ENOENT" || isTransientFileAccessError(error))
        ) {
            return undefined;
        }
        throw error;
    }
};

const stopCurrentJob = async (port: number, jobId: string) => {
    try {
        await fetch(`http://127.0.0.1:${port}/api/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId }),
            signal: AbortSignal.timeout(5000),
        });
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
