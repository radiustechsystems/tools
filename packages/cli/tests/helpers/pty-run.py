"""Run a command on a pseudo-terminal, answer password prompts, and write what it printed to a file.

usage: pty-run.py OUT_FILE PASSWORD COMMAND [ARGS...]

The test passes a throwaway password for a temporary keystore. Output goes to OUT_FILE, never to
this process's stdout, so a test run never prints what the terminal showed.
"""
import os
import pty
import re
import select
import sys
import time

out_path, password, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

# A prompt re-renders on every keystroke, so answer each distinct prompt label once. Two prompts
# with the same label in one run would need this to change.
captured = b""
deadline = time.time() + 30
answered = set()
scanned = 0
status = 1
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        captured += chunk
        # Prompts are coloured wherever colour is on (GitHub Actions sets GITHUB_ACTIONS, which
        # turns it on), so match the label with CSI sequences removed.
        plain = re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]", b"", captured[scanned:])
        for label in re.findall(rb"\? ([A-Za-z ]*password):", plain):
            if label not in answered:
                answered.add(label)
                time.sleep(0.05)
                os.write(fd, password.encode() + b"\r")
        scanned = max(0, len(captured) - 64)
# The child closes the terminal a moment before it exits, so wait for it until the deadline
# rather than killing it the instant the output ends.
done, wait_status = os.waitpid(pid, os.WNOHANG)
while done == 0 and time.time() < deadline:
    time.sleep(0.05)
    done, wait_status = os.waitpid(pid, os.WNOHANG)
if done == 0:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    print("pty-run: timed out; killed the command", file=sys.stderr)
else:
    status = os.waitstatus_to_exitcode(wait_status)
    if status != 0:
        print(f"pty-run: the command exited with status {status}", file=sys.stderr)
with open(out_path, "wb") as f:
    f.write(captured)
sys.exit(status)
