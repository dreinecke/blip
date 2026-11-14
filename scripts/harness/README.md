# Blip QML interaction harness (C-009)

Drives the **real `BlipView.qml`** with real clicks and keystrokes, the way no
text-reading structural test can. Built on Genome's real-input driver
(`~/code/genome/cli/src/genome/driver.py`, Genome 0.5.0, commit `1cf69f3`),
which runs the view in its own Xvfb and sends events through libXtst.

    scripts/harness/run.sh

Green prints the marker chain and `HARNESS GREEN`; anything missing exits 1
naming the failed assertion.

## What it proves, end to end

- clicking a thread row runs `openThread`/`showThread` and the thread load
- opening a conversation calls `hostWidget.markThreadRead` (the real gate)
- typing and pressing Return runs the whole `send()` body: pending bubble,
  send queue, `pumpSend`, `bridgeArgv` routing to the WhatsApp script
- the message text rides **stdin on the send, never argv** — asserted by a
  marker bound to the wa.ts send's own stdin, plus a negative check that the
  typed text appears in NO argv (the spellchecker also writes the compose
  text to its stdin, so the marker names its process)
- the post-send reload carries the pending send (`--pending-stdin`)
- the sent shot holds **more** blue mine-bubble than the pre-send shot —
  the fixture already renders one mine bubble, so only the delta proves the
  send rendered (pixel-checked, Pillow required)

## How it stays safe

- the view under test is a **copy** of the repo's QML/MJS; only import lines
  are rewritten (to the mocks). Nothing from the live plugin is touched.
- the mock `Process` and `execDetached` never spawn ANYTHING — that is the
  whole safety guarantee. argv is still built for real (so routing stays a
  testable marker), and fixture chats are WhatsApp-shaped
  (`+15550100001@c.us`, fiction range) so that argv points at the bridge
  script, not the Mac's `imsg-send`.
- `HOME`, `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` are the scratch build dir,
  so `~/` expansion stays inside the harness.
- no Quickshell instance, no IPC handler, no poller, no network.

## Gotchas recorded (each cost a debugging round)

- invoke **`qml6`**, not `qml`: `/usr/bin/qml` is the Qt 5.15 runtime and
  fails with only "Did not load any objects".
- set `QT_FORCE_STDERR_LOGGING=1` for the driven program and read the
  answer's **stderr** — Qt logs to the journal when stderr is not a terminal
  (Genome's diagnosis; verified on qml6).
- Quickshell's own runner maps no windows under `QT_QPA_PLATFORM=xcb`; its
  QML types also cannot be imported by plain qml6 (no plugin on disk), which
  is why the framework surface is mocked instead.
- the view's first row renders around y≈258 in the 420×660 window (below the
  pinned-section header), not near the top — the click targets in `run.sh`
  are calibrated to that.

## Layout

- `build.py` — builds the scratch tree (copy + import rewrite + mocks +
  pure-QML chrome copied live from `/usr/share/omarchy/shell`)
- `run.sh` — build, drive, assert
- `assert.py` — the marker chain + pixel check
- `Shell.qml`, `StubHost.qml` — the scratch host window and the 16-member
  stub host BlipView reads
- `mocks/` — Quickshell singleton, Process/StdioCollector (canned data),
  Style/Color (the real theme's numbers)

Not covered: `Panel.qml`'s KeyboardPanel wrapper and `BarWidget.qml` — those
need a scratch Wayland compositor (Quickshell maps no X windows) and remain a
follow-up if wanted.
