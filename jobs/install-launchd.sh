#!/bin/bash
# Installs the upload job as a launchd agent: it wakes every 10 minutes, uploads
# whatever has finished downloading, and removes the local copy once the upload
# is verified.
#
#   bash jobs/install-launchd.sh            # install and start
#   bash jobs/install-launchd.sh --remove   # stop and uninstall

set -euo pipefail

LABEL="ru.getcourse.upload"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE=$(command -v node)

if [[ "${1:-}" == "--remove" ]]; then
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Задача удалена."
    exit 0
fi

if [[ -z "$NODE" ]]; then
    echo "node не найден в PATH" >&2
    exit 1
fi

if ! grep -q '^YADISK_TOKEN=.\+' "${ROOT}/.env" 2>/dev/null; then
    echo "YADISK_TOKEN пуст в ${ROOT}/.env — сначала заполните токен." >&2
    exit 1
fi

mkdir -p "${ROOT}/logs" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE}</string>
        <string>${ROOT}/jobs/upload.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${ROOT}</string>

    <key>StartInterval</key>
    <integer>600</integer>

    <key>RunAtLoad</key>
    <true/>

    <!-- Never run two passes at once. -->
    <key>AbandonProcessGroup</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${ROOT}/logs/upload-job.log</string>
    <key>StandardErrorPath</key>
    <string>${ROOT}/logs/upload-job.log</string>

    <key>ProcessType</key>
    <string>Background</string>

    <key>LowPriorityIO</key>
    <true/>
</dict>
</plist>
PLIST_END

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Задача установлена: ${LABEL}"
echo "  проверяет папку каждые 10 минут"
echo "  журнал: ${ROOT}/logs/upload-job.log"
echo
echo "Состояние:   launchctl print gui/$(id -u)/${LABEL} | head -20"
echo "Запустить:   launchctl kickstart gui/$(id -u)/${LABEL}"
echo "Удалить:     bash jobs/install-launchd.sh --remove"
