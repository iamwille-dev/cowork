#!/bin/bash
set -euo pipefail

cd /app
(
  cd /app/backend
  exec env PORT=4000 ENCORE_INFRA_CONFIG_PATH=/app/encore/infra.config.json /app/encore/backend
) &
backend_pid=$!
node src/server.ts &
agent_pid=$!
node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 4400 &
web_pid=$!
trap 'kill "$backend_pid" "$agent_pid" "$web_pid" 2>/dev/null || true; wait || true' EXIT
trap 'exit 0' TERM INT
wait -n "$backend_pid" "$agent_pid" "$web_pid"
exit 1
