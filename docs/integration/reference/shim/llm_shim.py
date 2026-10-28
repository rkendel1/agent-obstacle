#!/usr/bin/env python3
"""OpenAI-compatible shim between stack-agent and llama-cpp-python's server.

- Translates response_format {"type":"json_schema","json_schema":{"schema":S}} into
  llama-cpp-python's {"type":"json_object","schema":S} (grammar-constrained decoding).
  With SHIM_SCHEMA=drop it removes response_format instead.
- Calls upstream NON-streaming (so usage is exact), then re-emits the reply as an SSE stream
  with a finish_reason chunk, a usage chunk and [DONE], which is what stack-agent requires.
- Appends one JSON line per call to SHIM_LOG: timing, usage, finish reason, sizes, the
  response_format sent, and (if SHIM_LOG_BODIES=1) the full request and reply text.

Usage: llm_shim.py LISTEN_PORT UPSTREAM_BASE   (e.g. 8081 http://127.0.0.1:8080)
"""
import json, os, sys, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]); UP = sys.argv[2].rstrip("/")
LOG = os.environ.get("SHIM_LOG", "shim-calls.jsonl")
BODIES = os.environ.get("SHIM_LOG_BODIES") == "1"
MODE = os.environ.get("SHIM_SCHEMA", "translate")
N = [0]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        with urllib.request.urlopen(UP + self.path) as r:
            data = r.read()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_POST(self):
        N[0] += 1
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        rf_in = body.get("response_format")
        if rf_in and rf_in.get("type") == "json_schema":
            if MODE == "drop":
                body.pop("response_format")
            else:
                body["response_format"] = {"type": "json_object", "schema": rf_in["json_schema"]["schema"]}
        body["stream"] = False; body.pop("stream_options", None)
        t0 = time.time()
        req = urllib.request.Request(UP + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
        entry = {"n": N[0], "start": t0, "messages": len(body.get("messages", [])),
                 "request_bytes": sum(len(m.get("content", "")) for m in body.get("messages", [])),
                 "max_tokens": body.get("max_tokens"), "response_format_in": (rf_in or {}).get("type"),
                 "response_format_sent": (body.get("response_format") or {}).get("type")}
        try:
            with urllib.request.urlopen(req, timeout=3600) as r:
                out = json.loads(r.read())
        except urllib.error.HTTPError as e:
            err = e.read()
            entry.update(status=e.code, error=err.decode(errors="replace")[:500], secs=time.time() - t0)
            self._log(entry)
            self.send_response(e.code); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(err))); self.end_headers(); self.wfile.write(err)
            return
        secs = time.time() - t0
        choice = out["choices"][0]; text = choice["message"].get("content") or ""
        usage = out.get("usage") or {}
        entry.update(status=200, secs=round(secs, 3), finish=choice.get("finish_reason"), usage=usage,
                     reply_chars=len(text),
                     tok_per_s=round(usage.get("completion_tokens", 0) / secs, 2) if secs else None)
        if BODIES:
            entry.update(request=body, reply=text)
        self._log(entry)
        self.send_response(200); self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache"); self.end_headers()
        base = {"id": out.get("id", "x"), "object": "chat.completion.chunk", "model": out.get("model")}
        def sse(obj):
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n"); self.wfile.flush()
        sse({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]})
        sse({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": choice.get("finish_reason") or "stop"}]})
        sse({**base, "choices": [], "usage": usage})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

    def _log(self, entry):
        with open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
