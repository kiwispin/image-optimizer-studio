$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$port = 4174
$url = "http://127.0.0.1:$port"

function Test-LocalPort {
  param([int]$Port)

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(350, $false)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

Set-Location -LiteralPath $root

if (Test-LocalPort -Port $port) {
  Write-Host "Image Optimizer Studio is already running at $url"
  Start-Process $url
  exit 0
}

function Get-NewestWriteTime {
  param([string[]]$Paths)

  $newest = [datetime]::MinValue
  foreach ($path in $Paths) {
    $full = Join-Path $root $path
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $item = Get-Item -LiteralPath $full
    if ($item.PSIsContainer) {
      $latest = Get-ChildItem -LiteralPath $full -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($latest -and $latest.LastWriteTime -gt $newest) { $newest = $latest.LastWriteTime }
    } elseif ($item.LastWriteTime -gt $newest) {
      $newest = $item.LastWriteTime
    }
  }
  return $newest
}

# Reinstall when package-lock.json changed since the last install (e.g. after a git pull).
$installMarker = Join-Path $root "node_modules\.package-lock.json"
$lockFile = Join-Path $root "package-lock.json"
if (-not (Test-Path -LiteralPath $installMarker) -or ((Get-Item -LiteralPath $lockFile).LastWriteTime -gt (Get-Item -LiteralPath $installMarker).LastWriteTime)) {
  Write-Host "Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

# Rebuild when the source is newer than the last build, so code updates actually take effect.
$serverEntry = Join-Path $root "dist\src\server\index.js"
$sourceTime = Get-NewestWriteTime -Paths @("src", "index.html", "vite.config.ts", "tsconfig.json", "package-lock.json")
if (-not (Test-Path -LiteralPath $serverEntry) -or $sourceTime -gt (Get-Item -LiteralPath $serverEntry).LastWriteTime) {
  Write-Host "Building the local production app..."
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed." }
}

Write-Host "Starting Image Optimizer Studio at $url"
# Local use: only listen on this computer, not the whole network.
$env:HOST = "127.0.0.1"
$env:PORT = "$port"
Start-Process $url
npm start
