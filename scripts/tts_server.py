#!/usr/bin/env python3
"""Persistent TTS server (Windows) - loads model once, streams audio chunks via local TCP.

Eliminates cold-start per call by keeping the model in memory.
Audio is streamed chunk-by-chunk to the client for immediate playback.

Usage:
    tts_server.py              # Start server (foreground)
    tts_server.py --daemon     # Start server (background, detached)

The server listens on 127.0.0.1 on an OS-assigned port. The port, an auth
token and the PID are written to ~/.claude-explainer/ (tts-server.port,
tts-server.token, tts-server.pid).

Each connection carries one request. The client sends UTF-8 JSON, then
half-closes its write side:
    {"token": "...", "text": "Hello world", "voice": "af_heart", "speed": 1.0}
    {"token": "...", "ping": true}

Optional "client": "<id>" - a new text request cancels any earlier, still
queued or running request with the same client id.

The text is split into sentences on (?<=[.!?])\\s+ and exactly one audio
chunk is sent per sentence (the VS Code extension relies on this count).

If the token is missing or wrong, the connection is closed with no reply.

Server responds with streamed audio:
    [4-byte big-endian length][float32 little-endian PCM mono 24000 Hz] per chunk
    [4 bytes: 0x00000000] to signal end of stream (also the reply to a ping)
"""

import atexit
import hmac
import json
import os
import re
import secrets
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

RUNTIME_DIR = Path.home() / ".claude-explainer"
PORT_FILE = RUNTIME_DIR / "tts-server.port"
TOKEN_FILE = RUNTIME_DIR / "tts-server.token"
PID_FILE = RUNTIME_DIR / "tts-server.pid"
LOG_FILE = RUNTIME_DIR / "tts-server.log"
STATE_FILES = (PORT_FILE, TOKEN_FILE, PID_FILE)

DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("TTS_SPEED", "1.0"))
IDLE_TIMEOUT = int(os.environ.get("TTS_IDLE_TIMEOUT", "300"))  # 5 min default

SKILL_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(os.environ.get("TTS_MODEL_DIR") or (SKILL_ROOT / "models"))
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

CONNECTION_ERRORS = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)


def load_tts():
    """Load the Kokoro ONNX model once."""
    model_path = MODEL_DIR / MODEL_FILE
    voices_path = MODEL_DIR / VOICES_FILE
    missing = [str(p) for p in (model_path, voices_path) if not p.is_file()]
    if missing:
        print(
            "[tts-server] ERROR: model file(s) not found: "
            + ", ".join(missing)
            + f"\n[tts-server] Place {MODEL_FILE} and {VOICES_FILE} in {MODEL_DIR} "
            "(or set TTS_MODEL_DIR).",
            flush=True,
        )
        sys.exit(1)

    from kokoro_onnx import Kokoro

    print(f"[tts-server] Loading model from {MODEL_DIR}...", flush=True)
    kokoro = Kokoro(str(model_path), str(voices_path))
    print("[tts-server] Model loaded, ready.", flush=True)
    return kokoro


# Must match SPLIT_RE in vscode-extension/src/extension.ts: the extension counts
# one audio chunk per sentence to advance highlights in sync with playback.
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
SENTENCE_PAUSE_S = 0.25


def generate_and_stream(conn, kokoro, text: str, voice: str, speed: float, is_stale=lambda: False):
    """Synthesize sentence by sentence and send exactly one chunk per sentence.

    Stops early (without an end marker) when is_stale() reports that a newer
    request from the same client has replaced this one.
    """
    import numpy as np

    lang = "en-gb" if str(voice).startswith("b") else "en-us"
    sentences = [s for s in SENTENCE_SPLIT_RE.split(text) if s]
    pause = np.zeros(int(SENTENCE_PAUSE_S * 24000), dtype="<f4")

    try:
        for i, sentence in enumerate(sentences):
            if is_stale():
                return
            try:
                samples, _sr = kokoro.create(sentence, voice=voice, speed=speed, lang=lang)
                audio = np.asarray(samples, dtype="<f4")
            except Exception as e:  # e.g. a sentence with no pronounceable text
                print(f"[tts-server] Sentence skipped ({e}): {sentence[:60]!r}", flush=True)
                audio = np.zeros(0, dtype="<f4")
            if i < len(sentences) - 1:
                audio = np.concatenate([audio, pause])
            if audio.size == 0:
                audio = pause  # keep one chunk per sentence
            audio_bytes = audio.tobytes()
            conn.sendall(struct.pack("!I", len(audio_bytes)) + audio_bytes)
        conn.sendall(struct.pack("!I", 0))
    except CONNECTION_ERRORS:
        return


def _remove_state_files():
    for path in STATE_FILES:
        try:
            path.unlink()
        except OSError:
            pass


def cleanup(*_):
    """Remove port, token and pid files, but only if this process owns them."""
    try:
        owner = int(PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return
    if owner != os.getpid():
        return
    for path in (PORT_FILE, TOKEN_FILE, PID_FILE):
        try:
            path.unlink()
        except OSError:
            pass


def _handle_sigint(*_):
    cleanup()
    sys.exit(0)


def is_server_alive() -> bool:
    """Check if an existing TTS server answers a ping on its recorded port."""
    try:
        port = int(PORT_FILE.read_text(encoding="utf-8").strip())
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except (OSError, ValueError):
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
            s.sendall(json.dumps({"token": token, "ping": True}).encode("utf-8"))
            s.shutdown(socket.SHUT_WR)
            s.settimeout(1)
            reply = b""
            while len(reply) < 4:
                chunk = s.recv(4 - len(reply))
                if not chunk:
                    break
                reply += chunk
            return reply == b"\x00\x00\x00\x00"
    except OSError:
        return False


def read_request(conn) -> bytes:
    """Read until the client half-closes its write side."""
    data = b""
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


def run_server():
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    # If another server is alive, exit instead of fighting for it
    if is_server_alive():
        print("[tts-server] Another instance is already running, exiting.", flush=True)
        sys.exit(0)

    # Clean up stale files from a crashed previous run
    _remove_state_files()

    atexit.register(cleanup)
    signal.signal(signal.SIGINT, _handle_sigint)

    kokoro = load_tts()
    activity = {"last": time.monotonic()}
    synth_lock = threading.Lock()  # only one synthesis at a time
    # Latest request number per client id: a newer request from the same client
    # (e.g. the user navigated to another segment) cancels the older ones.
    latest = {}
    latest_lock = threading.Lock()

    token = secrets.token_hex(16)

    def idle_watchdog():
        """Shut down the server after IDLE_TIMEOUT seconds of inactivity."""
        while True:
            time.sleep(30)
            idle = time.monotonic() - activity["last"]
            if idle >= IDLE_TIMEOUT:
                print(
                    f"[tts-server] Idle for {int(idle)}s, shutting down to free memory.",
                    flush=True,
                )
                cleanup()
                os._exit(0)

    if IDLE_TIMEOUT > 0:
        watchdog = threading.Thread(target=idle_watchdog, daemon=True)
        watchdog.start()
        print(f"[tts-server] Will auto-shutdown after {IDLE_TIMEOUT}s idle.", flush=True)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(5)
    port = server.getsockname()[1]

    PORT_FILE.write_text(str(port), encoding="ascii")
    TOKEN_FILE.write_text(token, encoding="ascii")
    PID_FILE.write_text(str(os.getpid()), encoding="ascii")

    print(f"[tts-server] Listening on 127.0.0.1:{port}", flush=True)

    def handle(conn):
        try:
            conn.settimeout(30)
            data = read_request(conn)
            conn.settimeout(None)

            if not data:
                return

            request = json.loads(data.decode("utf-8"))
            if not isinstance(request, dict):
                return

            supplied = request.get("token")
            if not isinstance(supplied, str) or not hmac.compare_digest(
                supplied.encode("utf-8"), token.encode("utf-8")
            ):
                return  # silently drop

            activity["last"] = time.monotonic()

            if request.get("ping"):
                conn.sendall(struct.pack("!I", 0))
                return

            text = str(request.get("text", "")).strip()
            voice = request.get("voice", DEFAULT_VOICE)
            speed = request.get("speed", DEFAULT_SPEED)

            if text:
                client = request.get("client")
                if isinstance(client, str) and client:
                    with latest_lock:
                        seq = latest.get(client, 0) + 1
                        latest[client] = seq

                    def is_stale():
                        return latest.get(client) != seq
                else:
                    def is_stale():
                        return False

                with synth_lock:
                    if not is_stale():
                        generate_and_stream(conn, kokoro, text, voice, speed, is_stale)
                activity["last"] = time.monotonic()
            else:
                conn.sendall(struct.pack("!I", 0))
        except CONNECTION_ERRORS:
            pass
        except Exception as e:
            print(f"[tts-server] Error: {e}", flush=True)
        finally:
            conn.close()

    while True:
        conn, _ = server.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


def find_venv_python():
    """Find the venv Python that has kokoro-onnx installed."""
    roots = []
    # Check TTS_WORKSPACE_ROOT first (set by VS Code extension)
    workspace_root = os.environ.get("TTS_WORKSPACE_ROOT")
    if workspace_root:
        roots.append(Path(workspace_root))
    # Fallback: relative to script (works when script is in project/scripts/)
    roots.append(Path(__file__).resolve().parent.parent)
    for root in roots:
        for exe in ("pythonw.exe", "python.exe"):
            candidate = root / ".venv" / "Scripts" / exe
            if candidate.is_file():
                return str(candidate.resolve())
    return sys.executable


if __name__ == "__main__":
    if "--daemon" in sys.argv:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        python_bin = find_venv_python()
        with open(LOG_FILE, "a", encoding="utf-8") as log:
            proc = subprocess.Popen(
                [python_bin, os.path.abspath(__file__)],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                close_fds=True,
                creationflags=(
                    subprocess.DETACHED_PROCESS
                    | subprocess.CREATE_NEW_PROCESS_GROUP
                    | subprocess.CREATE_NO_WINDOW
                ),
            )
        print(f"[tts-server] Started daemon (PID {proc.pid}) using {python_bin}")
        sys.exit(0)

    run_server()
