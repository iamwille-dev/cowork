#!/usr/bin/env bash
set -euo pipefail

# Encore exports a container image. Keep it in a loopback registry inside
# this build stage so the build needs no Docker daemon or external registry.
registry_address=localhost:5000
image="$registry_address/cowork-encore:build"
cat >/tmp/encore-registry.yml <<CONFIG
version: 0.1
storage:
  inmemory: {}
http:
  addr: 127.0.0.1:5000
CONFIG
registry serve /tmp/encore-registry.yml >/tmp/encore-registry.log 2>&1 &
registry_pid=$!
trap 'kill "$registry_pid" 2>/dev/null || true; wait "$registry_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  if curl -fsS "http://$registry_address/v2/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "http://$registry_address/v2/" >/dev/null; then
  cat /tmp/encore-registry.log >&2
  exit 1
fi

encore build docker --arch "$1" --push "$image"
entrypoint=$(crane config "$image" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).config.Entrypoint[0]')
mkdir -p /tmp/encore-image /out
crane export "$image" - | tar -xf - -C /tmp/encore-image -- "${entrypoint#/}" encore/infra.config.json
install -m 0755 "/tmp/encore-image/$entrypoint" /out/backend
install -m 0644 /tmp/encore-image/encore/infra.config.json /out/infra.config.json
rm -rf /tmp/encore-image
