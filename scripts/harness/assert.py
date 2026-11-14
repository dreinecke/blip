#!/usr/bin/env python3
"""Assert the C-009 harness drive: every marker of the interaction chain must
be present, the window must have mapped, and the sent shot must hold MORE
blue mine-bubble than the pre-send thread shot (the fixture already contains
one mine bubble, so only the delta proves the send rendered). The typed text
must ride stdin on the wa.ts send and must NEVER appear in any argv. Exits 1
naming the first missing piece — never silently green."""
import base64
import json
import sys
from pathlib import Path

from PIL import Image

SENT_BLUE = (10, 132, 255)
TYPED = "hello from the harness"

REQUIRED = [
    "HARNESS loaded",
    "HARNESS state listShowing=true",
    "MOCK process thread.ts",
    "STUB host markThreadRead chat=+15550100002@c.us",
    "MOCK stdin→wa.ts: " + TYPED,
    "MOCK process wa.ts argv=[\"send\",\"--to\",\"+15550100002@c.us\"",
    "--text-stdin",
    "--pending-stdin",
]


def blue_samples(png_bytes: bytes) -> int:
    import io

    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    return sum(
        1
        for y in range(0, im.height, 3)
        for x in range(0, im.width, 3)
        if abs(im.getpixel((x, y))[0] - SENT_BLUE[0]) < 24
        and abs(im.getpixel((x, y))[1] - SENT_BLUE[1]) < 24
        and abs(im.getpixel((x, y))[2] - SENT_BLUE[2]) < 24
    )


def main(answer_path: str) -> int:
    a = json.loads(Path(answer_path).read_text())
    if a.get("window") is None:
        print("FAIL: no window mapped")
        return 1
    if "all 7 steps were done" not in (a.get("drive") or ""):
        print(f"FAIL: drive did not complete: {a.get('drive')}")
        return 1
    err = base64.b64decode(a.get("stderr") or "").decode()
    for marker in REQUIRED:
        if marker not in err:
            print(f"FAIL: marker missing: {marker!r}")
            return 1
    for line in err.splitlines():
        if "argv=" in line and TYPED in line:
            print(f"FAIL: typed text leaked into argv: {line}")
            return 1
    shots = a.get("shots") or {}
    if "thread.png" not in shots or "sent.png" not in shots:
        print("FAIL: thread.png/sent.png shots missing")
        return 1
    before = blue_samples(base64.b64decode(shots["thread.png"]))
    after = blue_samples(base64.b64decode(shots["sent.png"]))
    Path("/tmp/blip-harness-sent.png").write_bytes(base64.b64decode(shots["sent.png"]))
    if before < 300:
        print(f"FAIL: fixture mine-bubble absent pre-send ({before} samples) — render broken")
        return 1
    if after - before < 200:
        print(f"FAIL: sent bubble did not render (blue delta {after - before} < 200; before={before}, after={after})")
        return 1
    for m in REQUIRED:
        print("ok:", m)
    print(f"ok: fixture bubble {before} samples, after send {after} (delta {after - before})")
    print("HARNESS GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
