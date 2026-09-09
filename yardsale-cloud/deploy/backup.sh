#!/usr/bin/env bash
set -euo pipefail

data_dir="${YARDSALE_CLOUD_DATA_DIR:-.yardsale-cloud}"
backup_dir="${YARDSALE_CLOUD_BACKUP_DIR:-$data_dir/backups}"
mkdir -p "$backup_dir"

if command -v restic >/dev/null 2>&1 && [[ -n "${RESTIC_REPOSITORY:-}" ]]; then
  restic backup "$data_dir" --exclude "$backup_dir" --tag yardsale-cloud
  if [[ "${RESTIC_PRUNE:-false}" == "true" ]]; then
    restic forget --tag yardsale-cloud --keep-daily "${RESTIC_KEEP_DAILY:-14}" --prune
  fi
else
  echo "restic is not configured; use the admin backup action or set RESTIC_REPOSITORY." >&2
  exit 1
fi
