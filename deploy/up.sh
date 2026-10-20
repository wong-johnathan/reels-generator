#!/usr/bin/env sh
# Ordered deploy for the NAS (R-016-2, R-017-2).
#
# The NAS only pulls pinned images; it never builds. This script runs the
# migration one-shot exactly once, then starts the always-on stack detached.
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

for required in RELEASE_TAG WEB_DIGEST WORKER_DIGEST OPS_DIGEST MINIO_IMAGE; do
  if ! grep -q "^${required}=." .env; then
    echo "deploy: .env has no value for ${required}. Append the CI images.env file (docs/DEPLOYMENT.md §2.3/§2.5)." >&2
    exit 1
  fi
done

echo "deploy: running the migration one-shot (once per deployment)"
docker compose --profile migrate run --rm migrate

echo "deploy: starting the stack"
docker compose up -d

echo "deploy: current state"
docker compose ps
