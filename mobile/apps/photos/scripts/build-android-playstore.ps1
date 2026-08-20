[CmdletBinding()]
param(
    [ValidateSet("debug", "release")]
    [string]$Mode = "release",
    [ValidateSet("playstore", "independent")]
    [string]$Flavor = "playstore",
    [string]$FlutterBin = "C:\Users\jmg29\.puro\envs\ente-3328\flutter\bin",
    [string]$JdkHome = "C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot",
    [switch]$SkipPubGet
)

$ErrorActionPreference = "Stop"

$flutter = Join-Path $FlutterBin "flutter.bat"
if (!(Test-Path -LiteralPath $flutter)) {
    throw "Flutter executable not found: $flutter"
}
if (!(Test-Path -LiteralPath $JdkHome)) {
    throw "JDK home not found: $JdkHome"
}

$env:JAVA_HOME = $JdkHome
$env:Path = "$FlutterBin;$JdkHome\bin;$env:Path"

$photosRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $photosRoot "android"
if ($Mode -eq "release") {
    $keyProperties = Join-Path $androidRoot "key.properties"
    $requiredSigningVariables = @(
        "SIGNING_KEY_PATH",
        "SIGNING_KEY_ALIAS",
        "SIGNING_KEY_PASSWORD",
        "SIGNING_STORE_PASSWORD"
    )
    $missingSigningVariables = @(
        $requiredSigningVariables | Where-Object {
            [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
        }
    )
    if (!(Test-Path -LiteralPath $keyProperties) -and $missingSigningVariables.Count -gt 0) {
        throw (
            "Release signing is not configured. Create $keyProperties or set " +
            ($missingSigningVariables -join ", ")
        )
    }
}

Push-Location $photosRoot
try {
    if (!$SkipPubGet) {
        & $flutter pub get
        if ($LASTEXITCODE -ne 0) {
            throw "flutter pub get failed with exit code $LASTEXITCODE"
        }
    }

    & $flutter build apk "--$Mode" --flavor $Flavor
    if ($LASTEXITCODE -ne 0) {
        throw "$Flavor $Mode APK build failed with exit code $LASTEXITCODE"
    }

    $apk = Join-Path $photosRoot "build\app\outputs\flutter-apk\app-$Flavor-$Mode.apk"
    if (!(Test-Path -LiteralPath $apk)) {
        throw "Expected APK was not produced: $apk"
    }

    Get-Item -LiteralPath $apk
} finally {
    Pop-Location
}
