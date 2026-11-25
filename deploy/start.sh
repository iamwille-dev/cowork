#!/bin/bash
set -euo pipefail

cd /app

# Mounted storage can have different ownership from the image directory.
if [[ "$(id -u)" == 0 ]]; then
  state_dir=/app/backend/.cowork
  mkdir -p "$state_dir"
  chown -h node:node "$state_dir"
  for database_file in "$state_dir"/memory.db{,-wal,-shm,-journal} "$state_dir"/slack-oauth.db{,-wal,-shm,-journal}; do
    if [[ -f "$database_file" && ! -L "$database_file" ]]; then
      chown -h node:node "$database_file"
    fi
  done
  exec gosu node /bin/bash /app/deploy/start.sh
fi

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
