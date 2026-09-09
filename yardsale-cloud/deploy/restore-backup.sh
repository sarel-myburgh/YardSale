#!/usr/bin/env bash
set -euo pipefail

backup_dir="${1:-}"
data_dir="${2:-${YARDSALE_CLOUD_DATA_DIR:-.yardsale-cloud}}"
if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
  echo "usage: $0 BACKUP_DIRECTORY [DATA_DIRECTORY]" >&2
  exit 2
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -e "$data_dir/yardsale-cloud.db" ]]; then
  echo "Refusing to overwrite an existing database. Stop the service and move $data_dir aside first." >&2
  exit 1
fi

cd "$project_dir"
node --experimental-sqlite --input-type=module -e 'import { restoreBackup } from "./src/ops.js"; restoreBackup({ backupDirectory: process.argv[1], dataDir: process.argv[2] });' "$backup_dir" "$data_dir"
echo "Restored $backup_dir into $data_dir"
