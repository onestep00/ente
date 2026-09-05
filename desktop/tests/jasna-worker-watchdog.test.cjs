const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the emitted production loop with a virtual clock and status I/O.
// Run tsc before this test so the installed main code is the code under test.
const source = fs.readFileSync(
    path.join(__dirname, "../app/main/services/jasna-worker-client.js"),
    "utf8",
);
const start = source.indexOf("const waitForJob =");
const end = source.indexOf("const completedOutputIsValid =", start);
assert.ok(start >= 0 && end > start);

async function run(statusAt, { native = true, heartbeat = true } = {}) {
    let elapsed = 0;
    let acknowledgements = 0;
    const context = {
        Date: { now: () => 1000 + elapsed },
        maximumJobTimeoutMs: 86400000,
        heartbeatTimeoutMs: 5000,
        jobStallTimeoutMs: 120000,
        statusPollIntervalMs: 1000,
        readStatus: async () => ({
            version: 1,
            jobId: "job",
            progress: 0,
            ...statusAt(elapsed),
        }),
        fileSize: async () => 0,
        fileModifiedTime: async () => (heartbeat ? 1000 + elapsed : 1000),
        completedOutputIsValid: async () => false,
        acknowledgeNativeJob: async () => {
            acknowledgements++;
        },
        validateCompletedOutput: async () => {},
        node_path_1: { default: path },
        setTimeout: (resolve, ms) => {
            elapsed += ms;
            resolve();
        },
    };
    const wait = vm.runInNewContext(
        source.slice(start, end) + "\nwaitForJob",
        context,
    );
    await wait(
        { durationSeconds: 30, outputDir: "output", onProgress() {} },
        "status",
        "job",
        1,
        native,
        new AbortController().signal,
    );
    return { elapsed, acknowledgements };
}

test("native admission wait over two minutes survives and starts a fresh stall interval", async () => {
    const result = await run((t) => ({
        state: t < 180000 ? "queued" : t < 270000 ? "running" : "complete",
    }));
    assert.equal(result.elapsed, 270000);
    assert.equal(result.acknowledgements, 1);
});
test("admitted work without progress still fails after two minutes", async () => {
    await assert.rejects(
        run(() => ({ state: "running" })),
        /no progress for 2 minutes/,
    );
});
test("queued work still requires a live worker heartbeat", async () => {
    await assert.rejects(
        run(() => ({ state: "queued" }), { heartbeat: false }),
        /heartbeat stopped/,
    );
});
test("queued work retains the overall job deadline", async () => {
    await assert.rejects(
        run(() => ({ state: "queued" })),
        /job timed out/,
    );
});
test("legacy workers cannot bypass the stall watchdog with queued status", async () => {
    await assert.rejects(
        run(() => ({ state: "queued" }), { native: false }),
        /no progress for 2 minutes/,
    );
});
test("real encoded activity keeps a long video alive when displayed progress is capped", async () => {
    const result = await run((t) => ({
        state: t < 300000 ? "running" : "complete",
        progress: 0.99,
        activity_seq: t,
    }));
    assert.equal(result.elapsed, 300000);
});
test("unchanged activity is not a heartbeat substitute for work", async () => {
    await assert.rejects(
        run(() => ({ state: "running", progress: 0.99, activity_seq: 10 })),
        /no progress for 2 minutes/,
    );
});
