"""Run a real terminal session; never import third-party Python packages."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

request = json.load(sys.stdin)
pid, master = pty.fork()
if pid == 0:
    os.chdir(request["cwd"])
    os.execve(request["node"], request["argv"], request["env"])

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
output = bytearray()
started = time.monotonic()
send_at = None
sent = False
cursor_responses = 0
status = None
timed_out = False
try:
    while True:
        now = time.monotonic()
        if now - started > request.get("timeout", 8):
            timed_out = True
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            break
        if send_at is not None and not sent and now >= send_at:
            os.write(master, bytes(request["keys"]))
            sent = True
        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                data = b""
            if data:
                output.extend(data)
                # terminal-kit asks the terminal for its cursor position before
                # installing the input field. Handle requests split over reads.
                requested = output.count(b"\x1b[6n")
                while cursor_responses < requested:
                    os.write(master, b"\x1b[30;24R")
                    cursor_responses += 1
                if (send_at is None and cursor_responses and
                        b"Enable telemetry? [y/N] " in output):
                    send_at = time.monotonic() + 0.1
            else:
                _, status = os.waitpid(pid, 0)
                break
        waited, child_status = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = child_status
            # Read remaining output until EOF on the next iteration.
            while True:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not data:
                    break
                output.extend(data)
            break
finally:
    os.close(master)
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)

print(json.dumps({
    "output": output.decode("utf-8", "replace"),
    "exitCode": os.waitstatus_to_exitcode(status),
    "timedOut": timed_out,
    "sent": sent,
    "cursorResponses": cursor_responses,
}))
