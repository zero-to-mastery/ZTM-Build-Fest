#!/usr/bin/env python3
"""Runs a command in a pty and turns marker text from the tape into keys only kitty can send.

VHS has no Cmd key, its Alt sends nothing extra on macOS, and its terminal
speaks no kitty keyboard protocol. So the tape types a marker character and
this wrapper rewrites it into the sequence orb reads:

  ⌘<key>     Alt+<key>, what Cmd sends through kitty's Cmd→Alt maps (kitty CSI <code>;3u)
  ⌃H / ⌃L    <C-g> h / <C-g> l  (move the keys to the sidebar / panes)
  ⌃[ / ⌃]    Ctrl+[ / Ctrl+]    (jump back / forward)
  🖱x,y;      a left click at column x, row y (1-based, SGR mouse)

Usage: keys.py <command> [args...]
"""
import fcntl, os, pty, select, signal, sys, termios, tty

CTRL = {"H": b"\x1b[103;5uh", "L": b"\x1b[103;5ul", "[": b"\x1b[91;5u", "]": b"\x1b[93;5u"}


class Translator:
    """Rewrites markers in the typed stream; VHS types each character on its own."""

    def __init__(self):
        self.pending = ""

    def feed(self, data):
        if not self.pending and data.isascii():
            return data
        out = b""
        for ch in data.decode(errors="ignore"):
            if self.pending.startswith("🖱"):
                if ch == ";":
                    x, y = self.pending[1:].split(",")
                    out += b"\x1b[<0;%s;%sM\x1b[<0;%s;%sm" % (x.encode(), y.encode(), x.encode(), y.encode())
                    self.pending = ""
                else:
                    self.pending += ch
            elif self.pending == "⌘":
                out += b"\x1b[%d;3u" % ord(ch)
                self.pending = ""
            elif self.pending == "⌃":
                out += CTRL.get(ch, ch.encode())
                self.pending = ""
            elif ch in ("⌘", "⌃", "🖱"):
                self.pending = ch
            else:
                out += ch.encode()
        return out


def size(fd):
    return fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)


def main():
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[1], sys.argv[1:])
    fcntl.ioctl(master, termios.TIOCSWINSZ, size(0))
    signal.signal(signal.SIGWINCH, lambda *_: fcntl.ioctl(master, termios.TIOCSWINSZ, size(0)))
    old = termios.tcgetattr(0)
    tty.setraw(0)
    keys = Translator()
    try:
        while True:
            try:
                ready, _, _ = select.select([0, master], [], [])
            except InterruptedError:
                continue
            if master in ready:
                try:
                    out = os.read(master, 65536)
                except OSError:
                    break
                if not out:
                    break
                os.write(1, out)
            if 0 in ready:
                data = keys.feed(os.read(0, 1024))
                if data:
                    os.write(master, data)
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, old)
        os.waitpid(pid, 0)


def check():
    t = Translator()
    assert t.feed("⌘".encode()) == b"" and t.feed(b"n") == b"\x1b[110;3u"
    assert t.feed("⌃H".encode()) == b"\x1b[103;5uh"
    assert t.feed(b"\x1b[A") == b"\x1b[A"
    assert t.feed("🖱12,".encode()) == b"" and t.feed(b"3;") == b"\x1b[<0;12;3M\x1b[<0;12;3m"
    assert t.feed("é".encode()) == "é".encode()


check()
if __name__ == "__main__":
    main()
