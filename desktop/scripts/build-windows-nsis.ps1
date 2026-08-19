[CmdletBinding()]
param(
    # Keep generated artifacts outside the Git worktree. The NSIS installer and
    # unpacked executable below are the only artifacts this script produces.
    [string]$OutputDirectory = "C:\Users\jmg29\builds\ente-nsis"
)

# This is the authoritative Windows release-build entrypoint. It intentionally
# does not install or launch Ente: packaging must finish and be inspected before
# it can replace a running client with active stream work.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Resolve every path from this script rather than the caller's current working
# directory so the documented invocation is reliable from PowerShell.
$desktopRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopRoot ".."))
$webRoot = Join-Path $repoRoot "web"
$wasmRoot = Join-Path $webRoot "packages\wasm"
$rendererOutput = Join-Path $webRoot "apps\photos\out"
$desktopOutput = Join-Path $desktopRoot "out"
$ffmpegPath = Join-Path $desktopRoot "node_modules\ffmpeg-static\ffmpeg.exe"
$wasmToolsRoot = Join-Path $env:LOCALAPPDATA "ente-build-tools\wasm-pack\v0.14.0"
$wasmPack = Join-Path $wasmToolsRoot "wasm-pack-v0.14.0-x86_64-pc-windows-msvc\wasm-pack.exe"
$wasmArchive = Join-Path $wasmToolsRoot "wasm-pack-v0.14.0-x86_64-pc-windows-msvc.tar.gz"
$wasmDownload = "https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.14.0/wasm-pack-v0.14.0-x86_64-pc-windows-msvc.tar.gz"

function Invoke-Checked {
    param(
        [string]$WorkingDirectory,
        [string]$Executable,
        [string[]]$Arguments
    )

    # Native executables only expose their failure through $LASTEXITCODE.
    # Convert each non-zero exit into a terminating PowerShell error so later
    # stages cannot package stale or incomplete renderer output.
    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Executable failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Assert-File {
    param([string]$Path, [string]$Description)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
}

function Install-OfficialWasmPack {
    # wasm-pack 0.14.0's npm installer still points at the repository before it
    # moved. Cache the matching Windows release in LOCALAPPDATA instead of
    # patching node_modules or committing a platform binary into this repository.
    if (Test-Path -LiteralPath $wasmPack -PathType Leaf) {
        return
    }

    New-Item -ItemType Directory -Path $wasmToolsRoot -Force | Out-Null
    Invoke-WebRequest -Uri $wasmDownload -OutFile $wasmArchive
    Invoke-Checked -WorkingDirectory $wasmToolsRoot -Executable "tar.exe" -Arguments @("-xzf", $wasmArchive, "-C", $wasmToolsRoot)
    Assert-File -Path $wasmPack -Description "official wasm-pack executable"
}

function Assert-OfficialWasmPackVersion {
    # A cached executable can be replaced manually or partially extracted. Check
    # the exact tool version before using it to generate renderer artifacts.
    $version = & $wasmPack --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch "^wasm-pack 0\.14\.0$") {
        throw "Expected wasm-pack 0.14.0, received '$version'"
    }
}

function Copy-RendererOutput {
    # The Electron application serves this static export. Require index.html to
    # ensure Next.js completed successfully before replacing desktop\out.
    Assert-File -Path (Join-Path $rendererOutput "index.html") -Description "Photos renderer output"

    # This is the only recursive deletion in the script. Resolve and verify the
    # exact generated target before replacing it; never remove a caller-supplied
    # or parent directory.
    $relativeOutput = [System.IO.Path]::GetRelativePath($desktopRoot, $desktopOutput)
    if ($relativeOutput.StartsWith("..")) {
        throw "Refusing to replace output outside the desktop workspace: $desktopOutput"
    }

    if (Test-Path -LiteralPath $desktopOutput) {
        Remove-Item -LiteralPath $desktopOutput -Recurse -Force
    }
    Copy-Item -LiteralPath $rendererOutput -Destination $desktopOutput -Recurse -Force
}

# Install Desktop dependencies with their package hooks enabled. ffmpeg-static
# may omit its downloaded binary even when Yarn itself exits successfully.
Invoke-Checked -WorkingDirectory $desktopRoot -Executable "npx.cmd" -Arguments @("--yes", "yarn@1.22.22", "install", "--frozen-lockfile")

if (-not (Test-Path -LiteralPath $ffmpegPath -PathType Leaf)) {
    # Repair the package's own missing binary before compiling. beforeBuild.js
    # repeats this guard as protection for direct Electron Builder invocations.
    Invoke-Checked -WorkingDirectory $desktopRoot -Executable "node.exe" -Arguments @(".\node_modules\ffmpeg-static\install.js")
}
Assert-File -Path $ffmpegPath -Description "ffmpeg-static executable"

# The web workspace's wasm-pack 0.14.0 npm hook references the moved repository
# and returns HTTP 404. Install its locked JavaScript dependencies without hooks,
# then run the corresponding official wasm-pack executable below.
Invoke-Checked -WorkingDirectory $webRoot -Executable "npx.cmd" -Arguments @("--yes", "yarn@1.22.22", "install", "--frozen-lockfile", "--ignore-scripts")
Install-OfficialWasmPack
Assert-OfficialWasmPackVersion
Invoke-Checked -WorkingDirectory $wasmRoot -Executable $wasmPack -Arguments @("build", "--target", "bundler", "--no-pack")

# Next.js needs this flag while producing the Electron-specific renderer. Restore
# the parent shell's value even if the renderer build fails.
$previousDesktopEnvironment = $env:_ENTE_IS_DESKTOP
$env:_ENTE_IS_DESKTOP = "1"
try {
    Invoke-Checked -WorkingDirectory $webRoot -Executable "npx.cmd" -Arguments @("--yes", "yarn@1.22.22", "workspace", "photos", "next", "build")
} finally {
    $env:_ENTE_IS_DESKTOP = $previousDesktopEnvironment
}

Copy-RendererOutput
# Emit main-process JavaScript before electron-builder. A no-emit check alone
# would leave desktop\app with an older main process.
Invoke-Checked -WorkingDirectory $desktopRoot -Executable ".\node_modules\.bin\tsc.cmd" -Arguments @()
Invoke-Checked -WorkingDirectory $desktopRoot -Executable ".\node_modules\.bin\electron-builder.cmd" -Arguments @(
    "--win", "nsis", "--x64",
    "--config.compression=store",
    "--config.mac.identity=null",
    "--config.directories.output=$OutputDirectory"
)

$unpackedFfmpeg = Join-Path $OutputDirectory "win-unpacked\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe"
# This final assertion prevents the exact failure where a successful NSIS build
# starts normally but every stream recreation fails with FFmpeg ENOENT.
Assert-File -Path $unpackedFfmpeg -Description "packaged ffmpeg-static executable"
Invoke-Checked -WorkingDirectory $desktopRoot -Executable ".\node_modules\.bin\tsc.cmd" -Arguments @("--noEmit")
Invoke-Checked -WorkingDirectory $repoRoot -Executable "git.exe" -Arguments @("diff", "--check")

Write-Host "Windows NSIS build completed: $OutputDirectory"
