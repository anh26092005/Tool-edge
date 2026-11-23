$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$localTools = Join-Path $root '.dev\tools'
$nodeDir = if (Test-Path -LiteralPath $localTools) {
    Get-ChildItem -LiteralPath $localTools -Directory -Filter 'node-v24.*-win-x64' |
        Sort-Object Name -Descending | Select-Object -First 1
}
$node = if ($nodeDir) { Join-Path $nodeDir.FullName 'node.exe' } else { (Get-Command node -ErrorAction Stop).Source }
$port = '3010'
$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*API_PORT\s*=\s*["'']?(\d+)') { $port = $Matches[1] }
    }
}
$url = "http://127.0.0.1:$port/dashboard/"
try {
    $existing = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    if ($existing.StatusCode -eq 200 -and $existing.Content.Contains('/dashboard/app.js')) {
        Start-Process $url
        Write-Output "Dashboard is already running: $url"
        exit 0
    }
} catch { }
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\control-api\server.js'))) {
    throw 'Build the project first: npm run build'
}
$logDir = Join-Path $root '.dev'
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$process = Start-Process -FilePath $node -ArgumentList 'scripts/main/startDashboard.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'dashboard.stdout.log') -RedirectStandardError (Join-Path $logDir 'dashboard.stderr.log')
Set-Content -LiteralPath (Join-Path $logDir 'control-api.pid') -Value $process.Id -NoNewline
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw "Dashboard exited. See $logDir\dashboard.stderr.log" }
    try {
        $ready = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($ready.StatusCode -eq 200 -and $ready.Content.Contains('/dashboard/app.js')) {
            Start-Process $url
            Write-Output "Dashboard is running: $url"
            exit 0
        }
    } catch { }
}
throw "Dashboard did not become ready. See $logDir\dashboard.stderr.log"
