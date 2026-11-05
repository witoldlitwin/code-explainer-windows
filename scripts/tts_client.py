"""Client helpers for the Code Explainer TTS server (Windows, stdlib only).

The server listens on 127.0.0.1 (TCP). Its port and auth token are published
in the per-user runtime directory once it is ready.
"""

import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

RUNTIME_DIR = Path.home() / ".claude-explainer"
SAMPLE_RATE = 24000

_PORT_FILE = RUNTIME_DIR / "tts-server.port"
_TOKEN_FILE = RUNTIME_DIR / "tts-server.token"


def read_endpoint():
    """Return (port, token) from the runtime dir, or None if unavailable."""
    try:
        port = int(_PORT_FILE.read_text(encoding="ascii").strip())
        token = _TOKEN_FILE.read_text(encoding="ascii").strip()
    except (OSError, ValueError):
        return None
    if not token:
        return None
    return port, token


def _recv_exactly(sock, n):
    """Receive exactly n bytes, or None if the connection closed early."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _request(payload, timeout):
    endpoint = read_endpoint()
    if endpoint is None:
        raise ConnectionError("TTS server endpoint not found")
    port, token = endpoint
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        body = dict(payload, token=token)
        sock.sendall(json.dumps(body).encode("utf-8"))
        sock.shutdown(socket.SHUT_WR)
        return sock
    except Exception:
        sock.close()
        raise


def ping(timeout=1.0):
    """Return True if the server answers a ping."""
    try:
        sock = _request({"ping": True}, timeout)
    except OSError:
        return False
    try:
        header = _recv_exactly(sock, 4)
        return header == b"\x00\x00\x00\x00"
    except OSError:
        return False
    finally:
        sock.close()


def synthesize(text, voice, speed, timeout=300.0):
    """Synthesize text; return raw float32 LE mono PCM (24000 Hz) bytes."""
    sock = _request({"text": text, "voice": voice, "speed": speed}, timeout)
    parts = []
    try:
        while True:
            header = _recv_exactly(sock, 4)
            if header is None:
                break
            length = struct.unpack(">I", header)[0]
            if length == 0:
                break
            chunk = _recv_exactly(sock, length)
            if chunk is None:
                break
            parts.append(chunk)
    finally:
        sock.close()
    return b"".join(parts)


def find_venv_python(root):
    """Return the venv python.exe under root, else sys.executable."""
    candidate = Path(root) / ".venv" / "Scripts" / "python.exe"
    if candidate.is_file():
        return str(candidate)
    return sys.executable


def ensure_server(timeout=60):
    """Make sure the TTS server is up; start the daemon if needed."""
    if ping():
        return True

    root = Path(__file__).resolve().parent.parent
    server_script = Path(__file__).resolve().parent / "tts_server.py"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    try:
        subprocess.Popen(
            [find_venv_python(root), str(server_script), "--daemon"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            cwd=str(root),
        )
    except OSError:
        return False

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ping():
            return True
        time.sleep(0.5)
    return False
