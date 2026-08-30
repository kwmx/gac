#!/usr/bin/env python3
import os
import pty
import select
import shutil
import signal
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HOME = tempfile.mkdtemp(prefix="gac-ctrl-c-smoke-")

pid, fd = pty.fork()

if pid == 0:
    os.chdir(ROOT)
    os.environ["HOME"] = HOME
    os.environ["USERPROFILE"] = HOME
    os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
    node = shutil.which("node") or "node"
    os.execlp(node, node, "bin/gac.js", "commit")

output = b""
sent = False
status = None
deadline = time.time() + 8

try:
    while time.time() < deadline:
        try:
            waited_pid, waited_status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if waited_pid == pid:
            status = waited_status
            break

        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if chunk:
                output += chunk
                if not sent and b"Enable telemetry? [y/N]" in output:
                    sent = True
                    os.write(fd, b"\x03")

    if status is None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
finally:
    while True:
        ready, _, _ = select.select([fd], [], [], 0)
        if not ready:
            break
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    os.close(fd)
    shutil.rmtree(HOME, ignore_errors=True)

text = output.decode("utf-8", "replace")

if not sent:
    raise AssertionError(f"telemetry prompt was reached; output={text[:1000]!r}")

if os.WIFEXITED(status):
    code = os.WEXITSTATUS(status)
else:
    code = 128 + os.WTERMSIG(status)

if code != 130:
    raise AssertionError(f"expected exit code 130, got {code}; output={text[:1000]!r}")

if "Nothing staged" in text:
    raise AssertionError(f"commit continued after Ctrl+C; output={text[:1000]!r}")

print("ctrl-c telemetry prompt smoke passed")
