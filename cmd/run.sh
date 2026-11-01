#!/bin/bash
# Scrapes every lesson listed in the training config and downloads the videos.
#
# Downloads are started by main.js itself (see scraper/download.js), so unlike
# upstream there is no separate tail -f | eval pipeline, and the script exits
# when the work is actually done.

set -o pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "${DIR}/.." && pwd)

date=$(date '+%Y-%m-%d_%H-%M-%S')
log_dir="${ROOT}/logs/${date}"
mkdir -p "$log_dir"

log="${log_dir}/scraper.log"

ln -sfn "$log" "${ROOT}/scraper.log"

echo "Logging to ${log}"

cd "$ROOT" || exit 1
node main.js 2>&1 | tee "$log"
