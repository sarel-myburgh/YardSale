#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3010}"
data_dir="${2:-${YARDSALE_CLOUD_DATA_DIR:-.yardsale-cloud}}"
disk_threshold="${YARDSALE_CLOUD_DISK_THRESHOLD_PERCENT:-85}"

curl --fail --silent "$base_url/healthz" >/dev/null
curl --fail --silent "$base_url/readyz" >/dev/null
metrics_args=(--fail --silent "$base_url/metrics")
if [[ -n "${YARDSALE_CLOUD_METRICS_TOKEN:-}" ]]; then
  metrics_args=(--fail --silent -H "Authorization: Bearer ${YARDSALE_CLOUD_METRICS_TOKEN}" "$base_url/metrics")
fi
curl "${metrics_args[@]}" >/dev/null

if [[ -d "$data_dir" ]]; then
  used_percent="$(df -P "$data_dir" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
  if [[ -n "$used_percent" && "$used_percent" -ge "$disk_threshold" ]]; then
    echo "disk usage ${used_percent}% is at or above ${disk_threshold}% for ${data_dir}" >&2
    exit 1
  fi
fi

echo "yardsale-cloud healthy"
