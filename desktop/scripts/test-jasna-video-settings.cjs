const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
    parseVideoSettings,
    videoJobSettings,
} = require("../app/main/services/jasna-video-settings.js");

test("external example and built defaults agree", () => {
    const example = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, "../jasna.config.example.json"),
            "utf8",
        ),
    );
    assert.deepEqual(parseVideoSettings(example), parseVideoSettings({}));
});

test("partial overrides produce an independent native job snapshot", () => {
    const config = {
        dlssnr: { style: 2, intensity: 0.5 },
        encoding: { cq: 21, targetBitrate: 7_000_000 },
    };
    const snapshot = JSON.parse(JSON.stringify(videoJobSettings(config, true)));
    config.dlssnr.intensity = 1.5;
    assert.equal(snapshot.dlssnr.intensity, 0.5);
    assert.equal(snapshot.dlssnr.style, 2);
    assert.equal(snapshot.encoding.cq, 21);
    assert.equal(snapshot.targetBitrate, 7_000_000);
    assert.equal(snapshot.encoding.targetBitrate, undefined);
    assert.equal(snapshot.segmentDuration, 2);
    assert.equal(snapshot.encoding.preset, "p7");
    assert.equal(videoJobSettings(config, true).dlssnr.intensity, 1.5);
});

test("unsupported workers retain old jobs but reject explicit new settings", () => {
    assert.deepEqual(videoJobSettings({ generator: "jasna-ente-v6" }, false), {
        segmentDuration: 2,
        minBitrate: 4_000_000,
        targetBitrate: 6_000_000,
        maxBitrate: 8_000_000,
        maxFps: 60,
    });
    for (const config of [{ dlssnr: {} }, { encoding: {} }])
        assert.throws(
            () => videoJobSettings(config, false),
            /matching native Release/,
        );
});

test("invalid types, unknown keys and capacity/bitrate violations fail", () => {
    for (const config of [
        null,
        [],
        { dlssnr: [] },
        { encoding: null },
        { dlssnr: { style: 1.5 } },
        { dlssnr: { preset: 4 } },
        { dlssnr: { skin: -0.5 } },
        { dlssnr: { intensity: NaN } },
        { dlssnr: { tone: Infinity } },
        { dlssnr: { structure: 2.01 } },
        { dlssnr: { autoMask: 1 } },
        { dlssnr: { globalTone: 1 } },
        { encoding: { preset: "ultra" } },
        { encoding: { cq: 17.5 } },
        { encoding: { lookahead: 33 } },
        { encoding: { bFrames: 5 } },
        { encoding: { maxBitrate: 8_000_001 } },
        { encoding: { maxFps: 61 } },
        { encoding: { targetBitrate: 3_000_000 } },
        { encoding: { audio: "aac" } },
        { encoding: { extraArgs: ["-crf", "10"] } },
        { encoding: { temporalAQ: "true" } },
    ])
        assert.throws(() => parseVideoSettings(config), /Jasna config/);
});

test("new native requests validate against the native schema", () => {
    const Ajv = require("ajv/dist/2020");
    const ajv = new Ajv();
    ajv.addFormat("uuid", /^[0-9a-f-]{36}$/i);
    ajv.addFormat("windows-absolute-path", /^[A-Z]:\\/i);
    const schemaPath =
        process.env.JASNA_JOB_SCHEMA ||
        path.resolve(
            __dirname,
            "../../../jasna-cuda/schemas/job-v1.schema.json",
        );
    const validate = ajv.compile(
        JSON.parse(fs.readFileSync(schemaPath, "utf8")),
    );
    for (const settings of [
        {},
        {
            dlssnr: { skin: 0, autoMask: true },
            encoding: { cq: 0, bFrames: 0 },
        },
    ]) {
        const job = {
            version: 1,
            jobId: "123e4567-e89b-12d3-a456-426614174000",
            inputPath: "C:\\input.mp4",
            outputDir: "C:\\output",
            keyInfoPath: "C:\\output\\output.m3u8.info",
            statusPath: "C:\\output\\jasna-status.json",
            durationSeconds: 5,
            sourceFps: 30,
            ...videoJobSettings(settings, true),
        };
        assert.equal(validate(job), true, JSON.stringify(validate.errors));
    }
});
