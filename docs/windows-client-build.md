# Windows client builds

작성일: 2026-08-19
갱신일: 2026-08-19
상태: 적용 중
적용 범위: Windows Android/Desktop 로컬 빌드

These commands are the verified local build path for the Ente Photos mobile and
desktop clients on Windows. Run them from a PowerShell prompt.

## Toolchain

- Flutter must be `3.32.8`. This checkout uses the Puro environment named
  `ente-3328`.
- Android builds require JDK 17. The verified installation is Microsoft
  OpenJDK 17.
- Rust Android targets and the Android SDK/NDK must already be installed.
- Desktop builds use Yarn `1.22.22`.

Set explicit paths before an Android build. Adding the Flutter `bin` directory
to `PATH` is required because `rive_native` invokes `dart` from CMake. Setting
Flutter's JDK preference alone does not make `dart.exe` visible to CMake.

```powershell
$Repo = "C:\Users\jmg29\code\ente"
$FlutterBin = "C:\Users\jmg29\.puro\envs\ente-3328\flutter\bin"
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot"
$env:Path = "$FlutterBin;$env:JAVA_HOME\bin;$env:Path"
```

Confirm the selected versions:

```powershell
& "$FlutterBin\flutter.bat" --version
java -version
dart --version
```

## Android Photos

Build the Play Store debug APK:

```powershell
Set-Location "$Repo\mobile\apps\photos"
& "$FlutterBin\flutter.bat" pub get
& "$FlutterBin\flutter.bat" analyze
& "$FlutterBin\flutter.bat" build apk --debug --flavor playstore
```

The APK is written below:

```text
mobile\apps\photos\build\app\outputs\flutter-apk\app-playstore-debug.apk
```

`home_widget 0.8.0` declares `androidx.glance:glance-appwidget:1.+`. The app's
root Android build file pins Glance to `1.0.0`; removing that pin currently lets
Gradle select `1.3.0-alpha02`, which requires compileSdk 37 and AGP 9.1 and
breaks this checkout's AGP 8.6 build.

Release builds additionally require the Ente signing properties and keystore.
Do not substitute the debug keystore or an unrelated repository key.

## Desktop Photos with Jasna

Use the single Windows NSIS build script for a release candidate. It performs
the fixed dependency installation, restores the official wasm-pack binary when
the npm package hook is broken, rebuilds the WebAssembly and Photos renderer,
packages the main process, and asserts that the packaged FFmpeg executable is
present.

```powershell
Set-Location "$Repo\desktop"
.\scripts\build-windows-nsis.ps1
```

The output is `C:\Users\jmg29\builds\ente-nsis`. Do not install a package
unless `win-unpacked\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe`
exists; the script checks this automatically.

The script deliberately uses `web` dependency installation with
`--ignore-scripts`: the locked `wasm-pack 0.14.0` npm hook references the
repository location before its move and fails with HTTP 404. It then downloads
and caches the matching official Windows executable under
`%LOCALAPPDATA%\ente-build-tools\wasm-pack\v0.14.0`. The source tree and lock
file remain unchanged.

The Jasna desktop package records its private release line, upstream base and
private revision as `2.0.0-ente-1.7.23-beta.jasna.N`. The current package
version is `2.0.0-ente-1.7.23-beta.jasna.2`: it is above public `1.x`
releases while retaining the exact upstream base, `1.7.23-beta`, in the
version string. The `.jasna.` marker disables the public Ente auto-updater,
including install-on-quit. Increment only the trailing Jasna revision for
subsequent private releases.

Use the package scripts so `_ENTE_IS_DESKTOP=1` is present while Next.js builds
the renderer. A plain `yarn build:photos` does not reproduce that desktop build
environment.

After dependency installation, confirm that `ffmpeg-static` has downloaded its
Windows binary before packaging:

```powershell
Get-Item "$Repo\desktop\node_modules\ffmpeg-static\ffmpeg.exe"
```

The Electron Builder `beforeBuild` hook repairs a missing binary by invoking
the package installer and fails the package build if the binary remains absent.
If the dependency install itself was interrupted, run its installer explicitly
before restarting the documented build sequence:

```powershell
Set-Location "$Repo\desktop"
node .\node_modules\ffmpeg-static\install.js
```

The required order for TypeScript-only desktop changes is `tsc` (emit) and then
Electron Builder. `tsc --noEmit` only checks types and does not update
`desktop\app\*.js`; packaging immediately after a no-emit check can therefore
ship an older main process. The repository-level details are in `AGENTS.md`.

```powershell
Set-Location "$Repo\desktop"
npx --yes yarn@1.22.22 install --frozen-lockfile
npx --yes yarn@1.22.22 build-renderer
npx --yes yarn@1.22.22 build-main:quick
```

The default unpacked application is written below `desktop\dist`. To keep a
test package out of the worktree, compile and package to an explicit directory:

```powershell
Set-Location "$Repo\desktop"
.\node_modules\.bin\tsc.cmd
.\node_modules\.bin\electron-builder.cmd --dir `
  --config.compression=store `
  --config.mac.identity=null `
  --config.directories.output="C:\Users\jmg29\builds\ente-jasna"
```

The executable is then:

```text
C:\Users\jmg29\builds\ente-jasna\win-unpacked\ente.exe
```

For an installable Windows package, use the NSIS target instead of `--dir`:

```powershell
Set-Location "$Repo\desktop"
.\node_modules\.bin\tsc.cmd
.\node_modules\.bin\electron-builder.cmd --win nsis --x64 `
  --config.compression=store `
  --config.mac.identity=null `
  --config.directories.output="C:\Users\jmg29\builds\ente-nsis"
```

The NSIS package includes `resources\app-update.yml`. A `--dir` package is a
smoke-test artifact and normally does not include that updater manifest.

`build-renderer` must be rerun after any change under `web/`. TypeScript-only
changes under `desktop/src` require `tsc` and repackaging. Packaging does not
replace a currently running Ente process; launch the new executable only after
the active stream job is in a safe state.

## Targeted verification used by stream recreation

```powershell
Set-Location "$Repo\web"
.\node_modules\.bin\tsc.cmd --noEmit -p apps\photos\tsconfig.json

Set-Location "$Repo\desktop"
.\node_modules\.bin\tsc.cmd --noEmit

Set-Location "$Repo\mobile\apps\photos"
& "$FlutterBin\flutter.bat" test test\models\metadata\file_magic_test.dart
```
