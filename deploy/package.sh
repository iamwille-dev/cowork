#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
release_dir=$(mktemp -d)
image="cowork-encore:$(basename "$release_dir")"
container=
cleanup() { if [[ -n "$container" ]]; then docker rm "$container" >/dev/null; fi; }
trap cleanup EXIT

(cd backend && encore build docker "$image") >&2
container=$(docker create "$image")
binary=$(docker image inspect "$image" --format '{{index .Config.Entrypoint 0}}')
mkdir -p "$release_dir/encore"
docker cp "$container:$binary" "$release_dir/encore/backend"
docker cp "$container:/encore/infra.config.json" "$release_dir/encore/infra.config.json"
tar -cf - Dockerfile .dockerignore package.json package-lock.json tsconfig.json next.config.mjs \
  postcss.config.mjs src deploy backend/encore.app backend/go.mod backend/go.sum backend/cowork backend/connections backend/internal | tar -xf - -C "$release_dir"

(
  cd "$release_dir"
  tar -cf - package.json package-lock.json tsconfig.json next.config.mjs \
    postcss.config.mjs src deploy backend encore | xz -3 -T2 > cowork-release.tar.xz
)
printf '%s\n' "$release_dir"
