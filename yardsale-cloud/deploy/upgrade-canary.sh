#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3010}"
image_version="${2:-}"
if [[ -z "$image_version" ]]; then
  echo "usage: $0 BASE_URL IMAGE_VERSION" >&2
  exit 2
fi

curl --fail --silent "$base_url/readyz" >/dev/null
echo "Control plane is ready; use the authenticated admin Upgrade action for the canary-aware store rollout: $image_version"
