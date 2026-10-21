#!/usr/bin/env sh
# Ordered deploy for the NAS (R-016-2, R-017-2).
#
# The NAS only pulls images; it never builds. This script pulls the newest
# application images, runs the migration one-shot exactly once, then starts the
# always-on stack detached.
# Compose cannot express `depends_on` from an always-on service to a service in
# a non-active profile, so the ordering is explicit here.
#
# Usage: ./deploy/up.sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "deploy: .env is missing. Copy the tracked template to .env and fill it (docs/DEPLOYMENT.md §2.2)." >&2
  exit 1
fi

echo "deploy: pulling the newest application images (tag :latest)"
# Explicit pull: `up` alone would happily reuse a cached :latest.
docker compose pull

echo "deploy: running the migration one-shot (once per deployment)"
docker compose --profile migrate run --rm migrate

echo "deploy: starting the stack"
docker compose up -d

echo "deploy: current state"
docker compose ps
