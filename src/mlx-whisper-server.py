"""
Lightning Whisper MLX STT Server

Persistent HTTP server that keeps the Whisper model loaded in memory.
Accepts WAV file uploads and returns transcriptions with minimal latency.
Uses lightning-whisper-mlx for ~200ms transcription on Apple Silicon.
"""

import time
import json
import os
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler

from lightning_whisper_mlx import LightningWhisperMLX

MODEL = os.environ.get("MLX_WHISPER_MODEL", "distil-small.en")
PORT = int(os.environ.get("MLX_WHISPER_PORT", "8787"))

# Pre-load model on startup
print(f"Loading model: {MODEL}...", flush=True)
start = time.time()
whisper = LightningWhisperMLX(model=MODEL, batch_size=12)
# Warm up
_header = b'RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80>\x00\x00\x00}\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00'
_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
_tmp.write(_header)
_tmp.close()
try:
    whisper.transcribe(_tmp.name)
except:
    pass
os.unlink(_tmp.name)
print(f"Model loaded in {time.time() - start:.1f}s", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/transcribe":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self.send_error(400, "No audio data")
            return

        audio_data = self.rfile.read(content_length)

        # Write to temp file (whisper needs a file path)
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.write(audio_data)
        tmp.close()

        try:
            start = time.time()
            result = whisper.transcribe(tmp.name)
            elapsed = time.time() - start

            transcript = (result.get("text") or "").strip()
            response = json.dumps({
                "text": transcript,
                "time_ms": round(elapsed * 1000),
            })

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(response.encode())

        except Exception as e:
            self.send_error(500, str(e))
        finally:
            os.unlink(tmp.name)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass  # Quiet


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Lightning Whisper server on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
        server.shutdown()
