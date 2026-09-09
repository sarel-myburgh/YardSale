#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3010}"
target_stores="${2:-10,50,100,200}"
printf 'health: '
curl --fail --silent "$base_url/healthz"
printf '\nready: '
curl --fail --silent "$base_url/readyz"
printf '\nmetrics: '
curl --fail --silent "$base_url/metrics"
printf '\n'
for count in ${target_stores//,/ }; do
  echo "capacity target ${count} stores: $(curl --fail --silent --output /dev/null --write-out '%{http_code} %{time_total}s' "$base_url/marketplace")"
done
