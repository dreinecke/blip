#!/usr/bin/env python3
"""Build the C-009 QML interaction harness into a scratch directory.

Creates <dest>/ with:
  shell.qml, StubHost.qml   — from scripts/harness/ (committed)
  blip/                     — a copy of the repo's QML/MJS with every
                              Quickshell / qs.* import rewritten to the mocks
  mocks/                    — the committed mock singletons plus the pure-QML
                              shell chrome components copied live from
                              /usr/share/omarchy/shell (Ui/Commons), imports
                              rewritten the same way
  home/                     — the scratch HOME the view sees

The QML under test is byte-identical to the repo except the rewritten import
lines; nothing in the copy runs a subprocess, and WhatsApp-shaped fixture
chats keep every send inside the copy. Run scripts/harness/run.sh, not this.

Usage: build.py <dest>
"""
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HARNESS = REPO / "scripts" / "harness"
SHELL_ROOT = Path("/usr/share/omarchy/shell")

# Longest first so `import Quickshell` never corrupts
# `import Quickshell.Hyprland`; that line is deliberately NOT rewritten — an
# unloadable module fails loudly if one of those files is ever loaded.
REWRITES = [
    "import Quickshell.Io",
    "import Quickshell",
    "import qs.Commons as Commons",
    "import qs.Commons",
    "import qs.Ui as Ui",
    "import qs.Ui",
]

# Pure-QML chrome the view's closure needs, copied live from the shell.
UI_TYPES = [
    "BorderOverlay", "BorderSurface", "PanelActionButton", "PanelHero",
    "PanelSectionHeader", "PanelSeparator", "PanelToolTip", "TextField",
]
COMMONS_SINGLETONS = ["Border", "Util"]

QT_NAMES = set(
    "Item Rectangle Text Column Row ListView TextField Button MouseArea "
    "Flickable ScrollView Timer Component Repeater TextEdit Label Menu "
    "MenuItem ToolTip Frame SpinBox Dialog Image Loader WheelHandler TapHandler "
    "FocusScope PropertyChanges Connections TextMetrics Shortcut Pane Flow "
    "GridLayout ColumnLayout RowLayout StackLayout BusyIndicator CheckBox "
    "RadioButton Switch Slider TextArea ScrollBar Popup ToolBar ProgressBar "
    "ComboBox Canvas DropArea HoverHandler MultiEffect QtObject "
    "ColorAnimation GradientStop Shape ShapePath PathSvg LinearGradient "
    # enum VALUES the closure references (Qt.*, TextInput.*) — never types
    "Password Backspace PointingHandCursor IbeamCursor SizeFDiagCursor".split()
)


TARGETS = {
    "import Quickshell.Io": "mocks/Quickshell/Io",
    "import Quickshell": "mocks/Quickshell",
    "import qs.Commons as Commons": "mocks/Commons",
    "import qs.Commons": "mocks/Commons",
    "import qs.Ui as Ui": "mocks/Ui",
    "import qs.Ui": "mocks/Ui",
}


def rewrite_imports(source: str, dest_root: Path) -> str:
    for old in REWRITES:
        aliased = old.endswith((" as Commons", " as Ui"))
        target = f'import "file:{dest_root}/{TARGETS[old]}"' + (" as Commons" if old.endswith("as Commons") else " as Ui" if old.endswith("as Ui") else "")
        source = source.replace(old, target)
    return source


def add_qmldir_entry(qmldir: Path, line: str) -> None:
    text = qmldir.read_text() if qmldir.exists() else ""
    if line not in text:
        qmldir.write_text(text + line)


MARKER = ".blip-harness"


def build(dest: Path) -> None:
    dest = dest.resolve()
    if dest.exists():
        # only ever replace a previous harness build — a typo'd destination
        # must not wipe an unrelated directory
        if not (dest / MARKER).exists():
            sys.exit(f"refusing to overwrite {dest}: not a previous harness build")
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    (dest / MARKER).write_text("built by scripts/harness/build.py\n")
    (dest / "home").mkdir()

    # committed harness pieces
    shutil.copy(HARNESS / "Shell.qml", dest / "shell.qml")
    shutil.copy(HARNESS / "StubHost.qml", dest / "StubHost.qml")
    shutil.copytree(HARNESS / "mocks", dest / "mocks")

    # repo QML/MJS copy with rewritten imports (TS files are never run)
    blip = dest / "blip"
    blip.mkdir()
    for pattern in ("*.qml", "*.mjs"):
        for f in REPO.glob(pattern):
            (blip / f.name).write_text(rewrite_imports(f.read_text(), dest))

    # scratch HOME for Quickshell.env("HOME") in the mock singleton
    singleton = dest / "mocks" / "Quickshell" / "QuickshellSingleton.qml"
    singleton.write_text(singleton.read_text().replace("__HARNESS_HOME__", str(dest / "home")))

    # pure-QML chrome from the live shell, imports rewritten
    for name in UI_TYPES:
        src = SHELL_ROOT / "Ui" / f"{name}.qml"
        target = dest / "mocks" / "Ui" / f"{name}.qml"
        target.write_text(rewrite_imports(src.read_text(), dest))
        add_qmldir_entry(target.parent / "qmldir", f"{name} 1.0 {name}.qml\n")
    for name in COMMONS_SINGLETONS:
        src = SHELL_ROOT / "Commons" / f"{name}.qml"
        target = dest / "mocks" / "Commons" / f"{name}.qml"
        target.write_text(rewrite_imports(src.read_text(), dest))
        add_qmldir_entry(target.parent / "qmldir", f"singleton {name} 1.0 {name}.qml\n")
    # the JS library Border.qml imports beside it
    shutil.copy(SHELL_ROOT / "Commons" / "BorderGeometry.js", dest / "mocks" / "Commons" / "BorderGeometry.js")

    # the shell chrome's own deps (rescanned until fixpoint); anything the
    # closure references that cannot be resolved FAILS THE BUILD LOUDLY — a
    # renamed shell component must never leave a silently-broken harness
    shell_qmldirs = {
        SHELL_ROOT / "Ui" / "qmldir": "Ui",
        SHELL_ROOT / "Commons" / "qmldir": "Commons",
    }

    def shell_registration(subdir: str, name: str) -> str:
        for q, sub in shell_qmldirs.items():
            if sub != subdir or not q.exists():
                continue
            for line in q.read_text().splitlines():
                if line.split()[0] == "singleton" and len(line.split()) > 1 and line.split()[1] == name:
                    return "singleton "
        return ""

    src_dirs = [("Ui", SHELL_ROOT / "Ui"), ("Commons", SHELL_ROOT / "Commons")]
    for _ in range(10):
        todo = {}
        for subdir, _src in src_dirs:
            for f in (dest / "mocks" / subdir).glob("*.qml"):
                for t in re.findall(r"\b([A-Z][A-Za-z0-9]+)\s*(?:\{|:)", f.read_text()):
                    if (blip / f"{t}.qml").exists():
                        continue
                    d = dest / "mocks"
                    if (d / "Ui" / f"{t}.qml").exists() or (d / "Commons" / f"{t}.qml").exists():
                        continue
                    if t in todo:
                        continue
                    # a same-named shell component shadows the Qt one
                    # (Omarchy ships its own TextField); Qt covers the rest
                    hit = next(((sub, sd) for sub, sd in src_dirs if (sd / f"{t}.qml").exists()), None)
                    if hit is not None:
                        todo[t] = hit
                    elif t not in QT_NAMES:
                        todo[t] = None
        if not todo:
            break
        unresolved = sorted(t for t, hit in todo.items() if hit is None)
        if unresolved:
            sys.exit(f"cannot resolve shell chrome referenced by the closure: {', '.join(unresolved)}")
        for t, (subdir, src_dir) in sorted(todo.items()):
            target = dest / "mocks" / subdir / f"{t}.qml"
            target.write_text(rewrite_imports((src_dir / f"{t}.qml").read_text(), dest))
            add_qmldir_entry(target.parent / "qmldir", f"{shell_registration(subdir, t)}{t} 1.0 {t}.qml\n")
    else:
        sys.exit("chrome dependency scan did not reach a fixpoint in 10 rounds")
    print(f"harness built at {dest}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(Path(sys.argv[1]))
