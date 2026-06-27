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

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Write-Host "Installing dependencies..."
  npm install
}

if (-not (Test-Path -LiteralPath (Join-Path $root "dist\src\server\index.js"))) {
  Write-Host "Building the local production app..."
  npm run build
}

Write-Host "Starting Image Optimizer Studio at $url"
Start-Process $url
npm start
