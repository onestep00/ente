/** Per-video snapshots shared with the native --ente-video-settings-v1 contract. */
export interface DlssNrSettings {
    style: number;
    preset: number;
    intensity: number;
    tone: number;
    structure: number;
    skin: number;
    autoMask: boolean;
}

export interface EncodingSettings {
    codec: "h264_nvenc";
    preset: string;
    tune: "hq";
    rateControl: "vbr";
    cq: number;
    multipass: "disabled" | "qres" | "fullres";
    lookahead: number;
    spatialAQ: boolean;
    temporalAQ: boolean;
    aqStrength: number;
    bFrames: number;
    bRefMode: "disabled" | "middle";
    vbvBufferSeconds: number;
    audio: "copy";
    minBitrate: number;
    targetBitrate: number;
    maxBitrate: number;
    maxFps: number;
    segmentDuration: number;
}

export interface JasnaVideoSettings {
    dlssnr: DlssNrSettings;
    encoding: EncodingSettings;
}

export const defaultVideoSettings: JasnaVideoSettings = {
    dlssnr: {
        style: 1,
        preset: 3,
        intensity: 0.7,
        tone: 0,
        structure: 1,
        skin: -1,
        autoMask: false,
    },
    encoding: {
        codec: "h264_nvenc",
        preset: "p7",
        tune: "hq",
        rateControl: "vbr",
        cq: 17,
        multipass: "fullres",
        lookahead: 32,
        spatialAQ: true,
        temporalAQ: true,
        aqStrength: 8,
        bFrames: 4,
        bRefMode: "middle",
        vbvBufferSeconds: 4,
        audio: "copy",
        minBitrate: 4_000_000,
        targetBitrate: 8_000_000,
        maxBitrate: 8_000_000,
        maxFps: 60,
        segmentDuration: 2,
    },
};

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value == "object" && !Array.isArray(value);

const invalid = (name: string, requirement: string): never => {
    throw new Error(`Jasna config ${name} ${requirement}`);
};

const section = (value: unknown, defaults: object, name: string) => {
    if (value === undefined) return { ...defaults } as Record<string, unknown>;
    if (!record(value)) return invalid(name, "must be an object");
    for (const key of Object.keys(value))
        if (!Object.hasOwn(defaults, key))
            invalid(`${name}.${key}`, "is not supported");
    return { ...defaults, ...value };
};

const number = (
    value: unknown,
    name: string,
    min: number,
    max: number,
    integer = true,
) => {
    if (
        typeof value != "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
    )
        return invalid(
            name,
            `must be ${integer ? "an integer" : "a number"} in [${min}, ${max}]`,
        );
    return value;
};

const flag = (value: unknown, name: string) =>
    typeof value == "boolean" ? value : invalid(name, "must be a boolean");

const choice = <T extends string>(
    value: unknown,
    name: string,
    choices: readonly T[],
): T =>
    typeof value == "string" && choices.includes(value as T)
        ? (value as T)
        : invalid(name, `must be one of ${choices.join(", ")}`);

export const parseVideoSettings = (value: unknown): JasnaVideoSettings => {
    if (!record(value)) return invalid("root", "must be an object");
    const nr = section(value.dlssnr, defaultVideoSettings.dlssnr, "dlssnr");
    const enc = section(
        value.encoding,
        defaultVideoSettings.encoding,
        "encoding",
    );
    const skin = number(nr.skin, "dlssnr.skin", -1, 2, false);
    if (skin < 0 && skin != -1)
        invalid("dlssnr.skin", "must be -1 or in [0, 2]");
    const dlssnr: DlssNrSettings = {
        style: number(nr.style, "dlssnr.style", 0, 2),
        preset: number(nr.preset, "dlssnr.preset", 0, 3),
        intensity: number(nr.intensity, "dlssnr.intensity", 0, 2, false),
        tone: number(nr.tone, "dlssnr.tone", 0, 2, false),
        structure: number(nr.structure, "dlssnr.structure", 0, 2, false),
        skin,
        autoMask: flag(nr.autoMask, "dlssnr.autoMask"),
    };
    const encoding: EncodingSettings = {
        codec: choice(enc.codec, "encoding.codec", ["h264_nvenc"]),
        preset: choice(enc.preset, "encoding.preset", [
            "p1",
            "p2",
            "p3",
            "p4",
            "p5",
            "p6",
            "p7",
        ]),
        tune: choice(enc.tune, "encoding.tune", ["hq"]),
        rateControl: choice(enc.rateControl, "encoding.rateControl", ["vbr"]),
        cq: number(enc.cq, "encoding.cq", 0, 51),
        multipass: choice(enc.multipass, "encoding.multipass", [
            "disabled",
            "qres",
            "fullres",
        ]),
        lookahead: number(enc.lookahead, "encoding.lookahead", 0, 32),
        spatialAQ: flag(enc.spatialAQ, "encoding.spatialAQ"),
        temporalAQ: flag(enc.temporalAQ, "encoding.temporalAQ"),
        aqStrength: number(enc.aqStrength, "encoding.aqStrength", 1, 15),
        bFrames: number(enc.bFrames, "encoding.bFrames", 0, 4),
        bRefMode: choice(enc.bRefMode, "encoding.bRefMode", [
            "disabled",
            "middle",
        ]),
        vbvBufferSeconds: number(
            enc.vbvBufferSeconds,
            "encoding.vbvBufferSeconds",
            1,
            4,
        ),
        audio: choice(enc.audio, "encoding.audio", ["copy"]),
        minBitrate: number(enc.minBitrate, "encoding.minBitrate", 1, 8_000_000),
        targetBitrate: number(
            enc.targetBitrate,
            "encoding.targetBitrate",
            1,
            8_000_000,
        ),
        maxBitrate: number(enc.maxBitrate, "encoding.maxBitrate", 1, 8_000_000),
        maxFps: number(enc.maxFps, "encoding.maxFps", 1, 60),
        segmentDuration: number(
            enc.segmentDuration,
            "encoding.segmentDuration",
            1,
            10,
            false,
        ),
    };
    if (
        encoding.minBitrate > encoding.targetBitrate ||
        encoding.targetBitrate > encoding.maxBitrate
    )
        invalid(
            "encoding",
            "requires minBitrate <= targetBitrate <= maxBitrate",
        );
    return { dlssnr, encoding };
};

export const videoJobSettings = (value: unknown, supported: boolean) => {
    const settings = parseVideoSettings(value);
    if (!supported) {
        if (
            record(value) &&
            (Object.hasOwn(value, "dlssnr") || Object.hasOwn(value, "encoding"))
        )
            throw new Error(
                "Jasna worker does not support --ente-video-settings-v1; install the matching native Release",
            );
        // Existing configs without these sections keep the legacy request.
        return {
            segmentDuration: 2,
            minBitrate: 4_000_000,
            targetBitrate: 6_000_000,
            maxBitrate: 8_000_000,
            maxFps: 60,
        };
    }
    const {
        segmentDuration,
        minBitrate,
        targetBitrate,
        maxBitrate,
        maxFps,
        ...encoding
    } = settings.encoding;
    return {
        segmentDuration,
        minBitrate,
        targetBitrate,
        maxBitrate,
        maxFps,
        dlssnr: settings.dlssnr,
        encoding,
    };
};
