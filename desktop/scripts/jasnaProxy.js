const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const buildJasnaProxy = async (appDir, platform, arch) => {
    const output = path.join(appDir, "build", "jasna-ffmpeg-proxy.exe");
    if (platform != "win32" || arch != "x64") {
        await fs.rm(output, { force: true });
        return;
    }
    const manifest = path.join(
        appDir,
        "native",
        "jasna-ffmpeg-proxy",
        "Cargo.toml",
    );
    await execFileAsync("cargo", [
        "build",
        "--release",
        "--manifest-path",
        manifest,
    ]);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(
        path.join(
            appDir,
            "native",
            "jasna-ffmpeg-proxy",
            "target",
            "release",
            "ente-jasna-ffmpeg-proxy.exe",
        ),
        output,
    );
};

if (require.main === module) {
    buildJasnaProxy(
        path.resolve(__dirname, ".."),
        process.platform,
        process.arch,
    ).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { buildJasnaProxy };
