#!/usr/bin/env bash
# C-009 — build and drive the QML interaction harness, then assert the marker
# chain. Exercises the real BlipView.qml with real clicks and keys through
# Genome's real-input driver (~/code/genome/cli/src/genome/driver.py) under
# Xvfb. Nothing in the harness runs a subprocess or touches the Mac bridge.
#
# Prereqs: Xvfb, qml6 (NOT qml — that is the Qt 5 runtime and loads nothing),
# Genome's driver at $GENOME_DRIVER (default below), Pillow for the shot check.
#
# A green run prints the marker chain and exits 0; anything missing exits 1
# with the line that failed, so CI or an agent can rely on the exit code.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${BLIP_HARNESS_DIR:-/tmp/blip-harness}"
GENOME_DRIVER="${GENOME_DRIVER:-$HOME/code/genome/cli/src/genome/driver.py}"
ANSWER="$(mktemp /tmp/blip-harness-answer-XXXXXX.json)"

for bin in Xvfb qml6 python3; do
  command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }
done
[ -f "$GENOME_DRIVER" ] || { echo "missing Genome driver at $GENOME_DRIVER"; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "missing: Pillow (the shot assertion needs it)"; exit 1; }

python3 "$REPO/scripts/harness/build.py" "$DEST"

STEPS='{"program": ["qml6", "'"$DEST"'/shell.qml"],
  "steps": [["shot", "list.png"], ["click", 210, 258], ["shot", "thread.png"],
            ["click", 210, 615], ["type", "hello from the harness"],
            ["key", "Return"], ["shot", "sent.png"]],
  "screen": "640x700x24", "settle": 1.0, "limit": 40}'

printf '%s' "$STEPS" \
  | env -u WAYLAND_DISPLAY -u XDG_CACHE_HOME -u XDG_CONFIG_HOME \
        QT_QPA_PLATFORM=xcb QT_FORCE_STDERR_LOGGING=1 \
        HOME="$DEST/home" python3 "$GENOME_DRIVER" > "$ANSWER"

python3 "$REPO/scripts/harness/assert.py" "$ANSWER"
