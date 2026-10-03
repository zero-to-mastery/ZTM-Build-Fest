$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $projectRoot
try {
    cargo build --manifest-path Cargo.toml --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) {
        throw "Cargo WASM build failed with exit code $LASTEXITCODE."
    }
    $wasmSource = Join-Path $projectRoot 'target/wasm32-unknown-unknown/release/kin.wasm'
    $wasmDestination = Join-Path $projectRoot 'web/wasm/kin_engine.wasm'
    Copy-Item -Path $wasmSource -Destination $wasmDestination -Force
} finally {
    Pop-Location
}
