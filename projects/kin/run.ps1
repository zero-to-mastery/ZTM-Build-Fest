$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
# server/start.mjs starts the service inside Node's permission model.
$serverPath = Join-Path $projectRoot 'server/start.mjs'
$minimumNodeVersion = [version]'24.16.0'
$nodeVersionText = $null
$nodeVersion = $null

if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersionText = (& node --version).Trim()
    if ($LASTEXITCODE -eq 0 -and $nodeVersionText -match '^v?(\d+)\.(\d+)\.(\d+)') {
        $nodeVersion = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    }
}

& (Join-Path $projectRoot 'build-wasm.ps1')
Write-Host 'WASM build succeeded.'
Write-Host 'Starting Kin. Wait for service_ready before opening the app. Press Ctrl+C to stop.'

if ($nodeVersion -and $nodeVersion -ge $minimumNodeVersion) {
    & node $serverPath
} elseif (Get-Command fnm -ErrorAction SilentlyContinue) {
    $compatibleVersions = foreach ($line in (& fnm list)) {
        if ($line -match '\bv?(\d+)\.(\d+)\.(\d+)\b') {
            $version = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
            if ($version -ge $minimumNodeVersion) {
                [pscustomobject]@{ Version = $version; Label = "v$version" }
            }
        }
    }
    $compatibleVersion = $compatibleVersions |
        Sort-Object Version |
        Select-Object -First 1

    if (-not $compatibleVersion) {
        throw "Kin requires Node.js $minimumNodeVersion or later. Current Node.js is '$nodeVersionText'; install a compatible runtime with fnm, then run this script again."
    }

    Write-Host "Node.js $nodeVersionText is below Kin's minimum; using fnm Node.js $($compatibleVersion.Label)."
    & fnm exec --using $compatibleVersion.Label node $serverPath
} else {
    throw "Kin requires Node.js $minimumNodeVersion or later. Current Node.js is '$nodeVersionText'; install a compatible runtime and run this script again."
}

if ($LASTEXITCODE -ne 0) {
    throw "Kin server exited with code $LASTEXITCODE. See the startup error above."
}
