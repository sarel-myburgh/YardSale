#!/usr/bin/env bash
set -euo pipefail

runtime="${1:-docker}"
image="${2:-yardsale:benchmark}"
name="yardsale-benchmark"
volume="yardsale-benchmark-data"

"$runtime" build --tag "$image" .
"$runtime" volume create "$volume" >/dev/null
"$runtime" run --detach --name "$name" --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges:true --publish 127.0.0.1:3000:3000 --volume "$volume:/data" "$image" >/dev/null
trap '"$runtime" rm --force "$name" >/dev/null 2>&1 || true; "$runtime" volume rm "$volume" >/dev/null 2>&1 || true' EXIT

started_ms="$(date +%s%N)"
started_ms="${started_ms:0:13}"
ready_ms=""
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then
    ready_ms="$(date +%s%N)"
    ready_ms="${ready_ms:0:13}"
    break
  fi
  sleep 1
done

echo "image_size_bytes=$($runtime image inspect "$image" --format '{{.Size}}')"
echo "container_memory=$($runtime stats --no-stream --format '{{.MemUsage}}' "$name")"
if [[ -n "$ready_ms" ]]; then
  echo "startup_ms=$((ready_ms - started_ms))"
  echo "startup_check=passed"
else
  echo "startup_check=failed"
  exit 1
fi
