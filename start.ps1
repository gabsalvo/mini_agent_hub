# Start the Mini Agent Hub end-to-end (Windows / PowerShell).
#
# Builds the server, frees the MCP Inspector's ports if a previous run left them
# open, then launches the Inspector WITH our server as its stdio child. One window,
# both processes.
#
#   ./start.ps1
#
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Inspector defaults: 6274 = web UI, 6277 = proxy. A leftover proxy is the usual
# "port is already in use" culprit, so free both before launching.
$inspectorPorts = 6274, 6277
foreach ($port in $inspectorPorts) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Write-Host "Freeing port $port (stopping PID $($listener.OwningProcess))..."
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Building..."
npm run build

Write-Host "Launching MCP Inspector with mini-agent-hub (Ctrl+C to stop)..."
npx @modelcontextprotocol/inspector node dist/server.js
