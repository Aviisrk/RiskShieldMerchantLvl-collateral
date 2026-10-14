#!/usr/bin/env python3
"""
RiskShield · Risk Desk launcher
================================
Serves risk_desk_localhost.html on http://localhost and opens it in your browser.

Serving over http://localhost (rather than double-clicking the file) is what unlocks
the "Choose save folder / Save report to folder" feature in Chrome/Edge — the File
System Access API is blocked on file:// pages.

Usage:
    python3 run_riskshield.py                 # serve + open browser (auto-pick a port)
    python3 run_riskshield.py --port 8080     # force a port
    python3 run_riskshield.py --no-browser    # serve only, don't open a browser
    python3 run_riskshield.py --bind 0.0.0.0  # expose on your LAN (use with care)

Stop the server with Ctrl+C.

Besides serving the page, this launcher exposes a same-origin POST /run endpoint so
the app can execute queries against Metabase directly (no copy-paste). The Metabase
session token is read server-side from the cf-analytics plugin config and is NEVER
sent to the browser:
    ~/.claude/plugins/config/cf-analytics/config.json
      { "metabase_session": "...", "redshift_db_id": <int> }
On an expired/unauthorized session the endpoint returns {"expired": true}, and the
page prompts for a fresh token which is passed back per-request (kept in the tab only).

No third-party dependencies — standard library only. Works on Python 3.7+.
"""

import argparse
import contextlib
import functools
import http.server
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

APP_FILE = "risk_desk_v4.html"
CONFIG = os.path.expanduser("~/.claude/plugins/config/cf-analytics/config.json")
MAX_ROWS = 1000000  # per-request row ceiling sent to Metabase (default cap is 2000)


def load_cfg():
    """Read Metabase url/session/db from the cf-analytics config (mode 600)."""
    cfg = json.load(open(CONFIG))
    url = (cfg.get("metabase_url") or cfg.get("url") or "https://metabase.cashfree.com").rstrip("/")
    tok = cfg.get("metabase_session") or cfg.get("session") or cfg.get("token")
    db = cfg.get("redshift_db_id")
    if not tok or db is None:
        raise ValueError("Missing metabase_session or redshift_db_id in %s" % CONFIG)
    return url, tok, db


def run_metabase(sql, session_override=""):
    """Execute native SQL via Metabase /api/dataset. Returns a JSON-able dict.
    Never includes the session token in the response."""
    try:
        url, tok, db = load_cfg()
    except FileNotFoundError:
        return {"ok": False, "error": "Config not found at %s — cannot reach Metabase." % CONFIG}
    except (ValueError, json.JSONDecodeError) as e:
        return {"ok": False, "error": "Config error: %s" % e}
    if session_override:
        tok = session_override
    # Metabase /api/dataset silently caps results at 2000 rows unless explicit constraints are
    # sent. Lift the cap; if Metabase still truncates (rows_truncated), fail loud below rather
    # than hand the app an incomplete slice that looks complete.
    body = json.dumps({"database": db, "type": "native", "native": {"query": sql},
                       "constraints": {"max-results": MAX_ROWS, "max-results-bare-rows": MAX_ROWS}}).encode()
    req = urllib.request.Request(url + "/api/dataset", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Metabase-Session", tok)
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=900)  # bounded but generous — an indefinite timeout can't distinguish "slow" from "dead" (a stalled TCP read hangs forever with zero signal); 900s gives real warehouse scans room while still surfacing a genuine hang as an error
        res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        secs = round(time.time() - t0, 1)
        raw = ""
        with contextlib.suppress(Exception):
            raw = e.read().decode()
        if e.code in (401, 403):
            return {"ok": False, "expired": True, "seconds": secs,
                    "error": "Metabase session expired or unauthorized (HTTP %d)." % e.code}
        try:
            res = json.loads(raw or "{}")
        except json.JSONDecodeError:
            return {"ok": False, "error": "HTTP %d: %s" % (e.code, raw[:400]), "seconds": secs}
    except Exception as e:
        return {"ok": False, "error": "Transport error: %s" % e, "seconds": round(time.time() - t0, 1)}
    secs = round(time.time() - t0, 1)
    if res.get("error"):
        return {"ok": False, "error": str(res.get("error"))[:800], "seconds": secs}
    d = res.get("data", {})
    cols = [c.get("name") for c in d.get("cols", [])]
    if not cols:
        return {"ok": False, "error": "Query returned no columns.", "seconds": secs}
    rows = d.get("rows", [])
    if d.get("rows_truncated"):
        n = d.get("rows_truncated")
        n = n if isinstance(n, int) and not isinstance(n, bool) else len(rows)
        return {"ok": False, "truncated": True, "seconds": secs,
                "error": "truncated at %d rows" % n}
    # max_rows tells the page this launcher lifts Metabase's 2000-row cap (an older launcher omits it, and the
    # page then treats an exactly-2000-row page as truncated).
    return {"ok": True, "cols": cols, "rows": rows, "seconds": secs, "max_rows": MAX_ROWS}


def find_free_port(preferred, bind):
    """Return `preferred` if it's free, else the next available port."""
    candidates = [preferred] + [preferred + i for i in range(1, 50)] + [0]
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((bind, port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("Could not find a free port to bind to.")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that logs compactly and serves UTF-8 HTML correctly."""

    def log_message(self, fmt, *args):
        sys.stdout.write("  · %s\n" % (fmt % args))

    def end_headers(self):
        # Encourage fresh loads while iterating locally.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") != "/run":
            self._send_json(404, {"ok": False, "error": "Unknown endpoint."})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(400, {"ok": False, "error": "Bad request: %s" % e})
            return
        sql = (payload.get("sql") or "").strip()
        if not sql:
            self._send_json(400, {"ok": False, "error": "No SQL provided."})
            return
        result = run_metabase(sql, (payload.get("session") or "").strip())
        self._send_json(200, result)


def main():
    parser = argparse.ArgumentParser(
        description="Serve the RiskShield Risk Desk app on localhost."
    )
    parser.add_argument("--port", type=int, default=8080, help="Preferred port (default 8080).")
    parser.add_argument("--bind", default="127.0.0.1", help="Bind address (default 127.0.0.1).")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser.")
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    app_path = os.path.join(here, APP_FILE)
    if not os.path.isfile(app_path):
        raise SystemExit(
            "Could not find %s next to this script.\n"
            "Keep run_riskshield.py and %s in the same folder." % (APP_FILE, APP_FILE)
        )

    os.chdir(here)  # serve this folder so the app + any saved reports are reachable
    port = find_free_port(args.port, args.bind)
    handler = functools.partial(QuietHandler, directory=here)

    httpd = http.server.ThreadingHTTPServer((args.bind, port), handler)
    host = "localhost" if args.bind in ("127.0.0.1", "0.0.0.0") else args.bind
    url = "http://%s:%d/%s" % (host, port, APP_FILE)

    print("=" * 64)
    print("  RiskShield · Risk Desk v4 — serving on:")
    print("    %s" % url)
    print("  Folder-save (Chrome/Edge) works because this is http://localhost.")
    print("  Press Ctrl+C to stop.")
    print("=" * 64)

    if not args.no_browser:
        threading.Thread(
            target=lambda: (time.sleep(0.6), webbrowser.open(url)), daemon=True
        ).start()

    with contextlib.suppress(KeyboardInterrupt):
        httpd.serve_forever()
    httpd.server_close()
    print("\nStopped. Bye.")


if __name__ == "__main__":
    main()
