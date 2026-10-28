#!/usr/bin/env python3
"""A scripted OpenAI-compatible SSE endpoint: replies with the next line of SCRIPT_FILE each call.

Usage: scripted_model.py PORT SCRIPT_FILE   (one JSON decision per line)
"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]); LINES = [l.strip() for l in open(sys.argv[2]) if l.strip()]
I = [0]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["content-length"]))
        text = LINES[min(I[0], len(LINES) - 1)]; I[0] += 1
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for obj in ({"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 10}}):
            self.wfile.write(b"data: " + json.dumps({"model": "scripted", **obj}).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
