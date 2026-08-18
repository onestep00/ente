# Windows client builds

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

Use the package scripts so `_ENTE_IS_DESKTOP=1` is present while Next.js builds
the renderer. A plain `yarn build:photos` does not reproduce that desktop build
environment.

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
