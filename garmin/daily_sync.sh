#!/data/data/com.termux/files/usr/bin/bash
# Daily sync + rebuild, meant to be triggered by termux-job-scheduler
# (see garmin/README section on automation). Safe to run manually too.
set -e
cd "$(dirname "$0")"

python3 sync.py --days 90 >> sync.log 2>&1
python3 build_dashboard.py >> sync.log 2>&1

# Make the fresh dashboard easy to open outside Termux's private storage.
if [ -d "$HOME/storage/downloads" ]; then
    cp dashboard.html "$HOME/storage/downloads/dashboard.html"
fi

if command -v termux-notification >/dev/null 2>&1; then
    termux-notification --title "Wellness dashboard updated" \
        --content "Synced $(date '+%Y-%m-%d %H:%M')" \
        --id wellness-sync
fi
