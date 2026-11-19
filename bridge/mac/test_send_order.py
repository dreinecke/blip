#!/usr/bin/env python3
"""Ordering tests for imsg-send's file+caption path.

The text must leave the moment the FILE AppleScript returns — a caller with a
bridge timeout (Marmalade answers the iPhone within 15s; Dave, Q-031) must not
lose the headline to the up-to-20s wait for Messages' own copy of the file.
The wait gates cleanup and error reporting only, never the send order.

Method: load imsg-send as a module, stub every Mac-touching function, drive
main() with --file-stdin plus --text-stdin-bytes, and record the call order.
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import os
import sys
import unittest
from unittest import mock


def load_send():
    path = os.path.join(os.path.dirname(__file__), "imsg-send")
    loader = importlib.machinery.SourceFileLoader("blip_imsg_send", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FileCaptionOrderTests(unittest.TestCase):
    def setUp(self):
        self.send = load_send()
        self.calls = []
        def rec(name):
            def fn(*a, **k):
                self.calls.append(name)
                if name == "run_applescript":
                    return (0, "", "")
                if name == "wait_for_copy":
                    return (True, None)
                return None
            return fn
        self.patches = [
            mock.patch.object(self.send, "stage_stdin_file", lambda name, n: "/tmp/staged"),
            mock.patch.object(self.send, "consent_banner", rec("banner")),
            mock.patch.object(self.send, "_max_attachment_rowid", lambda: 0),
            mock.patch.object(self.send, "run_applescript", rec("run_applescript")),
            mock.patch.object(self.send, "wait_for_copy", rec("wait_for_copy")),
            mock.patch.object(self.send, "unstage", rec("unstage")),
            mock.patch.object(self.send, "keep_sent", rec("keep_sent")),
            mock.patch.object(self.send, "find_service_id", lambda s: "S"),
            mock.patch.object(self.send, "has_existing_chat", lambda h, s: True),
            mock.patch.object(self.send, "scrub_dashes", lambda t: (t, 0)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def run_send(self, argv, stdin=b"photo-bytes\x00caption bytes here"):
        argv = ["imsg-send", "--to", "+15551234567", "--yes", "--keep-dashes"] + argv
        out = io.StringIO()
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(stdin), "utf-8") if False else sys.stdin), \
             contextlib.redirect_stdout(out):
            # feed the binary stdin the tool reads via sys.stdin.buffer
            import types
            fake = types.SimpleNamespace(buffer=io.BytesIO(stdin))
            with mock.patch.object(sys, "stdin", fake):
                try:
                    self.send.main()
                    return 0, out.getvalue()
                except SystemExit as e:
                    msg = str(e.code) if isinstance(e.code, str) else ""
                    return (e.code or 0), out.getvalue() + "\n" + msg

    def test_text_sends_before_the_copy_wait(self):
        code, out = self.run_send(["--file-stdin", "--file-bytes", "12",
                                   "--text-stdin-bytes", "19"])
        order = [c for c in self.calls if c in ("run_applescript", "wait_for_copy")]
        self.assertEqual(code, 0, out)
        self.assertEqual(
            order,
            ["run_applescript", "run_applescript", "wait_for_copy"],
            f"text must follow the file send and precede the copy wait, got {order}",
        )
        self.assertIn("text: sent.", out)
        self.assertIn("file: sent.", out)

    def test_file_send_failure_still_sends_text_and_reports_both(self):
        self.send.run_applescript = lambda script: (1, "", "as failure") if "sendFile" in script or True else (0, "", "")
        # make only the FIRST applescript fail
        real = self.send.run_applescript
        state = {"n": 0}
        def fail_first(script):
            state["n"] += 1
            self.calls.append("run_applescript")
            return (1, "", "as failure") if state["n"] == 1 else (0, "", "")
        self.send.run_applescript = fail_first
        code, out = self.run_send(["--file-stdin", "--file-bytes", "12",
                                   "--text-stdin-bytes", "19"])
        self.assertNotEqual(code, 0)
        self.assertIn("file (as failure)", out, f"exit message missing from {out!r}")
        self.assertIn("text: sent.", out)
        self.assertNotIn("wait_for_copy", self.calls, "a failed file send must not wait for a copy")

    def test_copy_error_unstages_and_reports_after_text(self):
        self.send.wait_for_copy = lambda *a, **k: (False, "7")
        code, out = self.run_send(["--file-stdin", "--file-bytes", "12",
                                   "--text-stdin-bytes", "19"])
        self.assertNotEqual(code, 0)
        self.assertIn("file (Messages error 7", out)
        self.assertIn("text: sent.", out)
        self.assertIn("unstage", self.calls)
        order = [c for c in self.calls if c in ("run_applescript", "wait_for_copy", "unstage")]
        self.assertEqual(order[-1], "unstage")


if __name__ == "__main__":
    unittest.main()
