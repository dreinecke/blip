#!/usr/bin/env bash
# Blip — Mac-side install. Run this ON THE MAC (paste one line from
# blip-setup, or run it from a checkout). Idempotent.
#
# What it does:
#   1. copies the bridge tools into ~/.blip/bin (imsg, imsg-send, contacts,
#      tcc-check) — read-only sqlite over chat.db, AppleScript send, Contacts;
#   2. makes sure Remote Login (sshd) is on, since Blip talks over ssh;
#   3. explains the two TCC grants that cannot be scripted:
#        • Full Disk Access  → /usr/libexec/sshd-keygen-wrapper (reads chat.db)
#        • Automation        → allow "sshd-keygen-wrapper" to control Messages
#      and runs tcc-check so you can see which are still missing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$HOME/.blip/bin"
mkdir -p "$dest"
for t in imsg imsg-send contacts tcc-check blip-check; do
  if [[ -f "$here/$t" ]]; then
    install -m 0755 "$here/$t" "$dest/$t"
  else
    echo "install.sh: missing $here/$t" >&2; exit 1
  fi
done
echo "✓ bridge tools installed to $dest"

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found — install Xcode Command Line Tools: xcode-select --install" >&2
fi

if sudo -n true 2>/dev/null; then
  sudo systemsetup -setremotelogin on >/dev/null 2>&1 && echo "✓ Remote Login (sshd) enabled" || true
else
  echo "• Enable Remote Login: System Settings → General → Sharing → Remote Login (or: sudo systemsetup -setremotelogin on)"
fi

cat <<'EOF'

Two permissions must be granted by hand (macOS will not let a script do it):

  1. Full Disk Access  → System Settings → Privacy & Security → Full Disk Access
     add:  /usr/libexec/sshd-keygen-wrapper   (press ⌘⇧G in the file picker)
     This is what lets an ssh session read ~/Library/Messages/chat.db.

  2. Automation → Messages: the first send from an ssh session pops a prompt on
     THIS Mac's screen: "sshd-keygen-wrapper wants to control Messages" — click
     Allow once. (blip-setup triggers this with a dry-run-free self-send.)

Then check:
EOF
python3 "$dest/blip-check" || true
