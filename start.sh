#!/usr/bin/env bash
# Start the Mini Agent Hub end-to-end (macOS / Linux).
#
# Builds the server, frees the MCP Inspector's ports if a previous run left them
# open, then launches the Inspector WITH our server as its stdio child.
#
#   ./start.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# Inspector defaults: 6274 = web UI, 6277 = proxy. Free both before launching.
for port in 6274 6277; do
  pid="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [ -n "${pid}" ]; then
    echo "Freeing port ${port} (killing pid ${pid})..."
    kill -9 ${pid} 2>/dev/null || true
  fi
done

echo "Building..."
npm run build

echo "Launching MCP Inspector with mini-agent-hub (Ctrl+C to stop)..."
npx @modelcontextprotocol/inspector node dist/server.js
