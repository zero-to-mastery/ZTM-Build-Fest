$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

& (Join-Path $projectRoot 'build-wasm.ps1')
Write-Host 'WASM build succeeded.'
Write-Host 'Starting Kin. Wait for service_ready before opening the app. Press Ctrl+C to stop.'
node (Join-Path $projectRoot 'server/server.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "Kin server exited with code $LASTEXITCODE. See the startup error above."
}
