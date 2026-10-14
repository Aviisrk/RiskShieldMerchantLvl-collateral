#!/usr/bin/env python3
"""
RiskShield Risk Desk - Redshift runner (self-contained, no paste-list handoff).

Runs the 6 tokenized queries in redshift_sql/ for a given merchant + window, via
Metabase's /api/dataset. Each query is fully self-contained: it derives its own
disputed-identifier universe from the base tables, so the only inputs are the MID
and the day-window (__SLACK__ = __DAYS__ + 60 is computed automatically).

Usage:
    python3 run_riskshield_redshift.py <MID> [DAYS]        # run all 6
    python3 run_riskshield_redshift.py <MID> [DAYS] q3     # run one (q1|q2|q3|q4a|q4b|q4c)

Credentials are read from the cf-analytics plugin config (never hardcoded):
    ~/.claude/plugins/config/cf-analytics/config.json
      { "metabase_url": "...", "metabase_session": "...", "redshift_db_id": <int> }

Notes
-----
* Q3 is split into two chunks (q3a phone, q3b email) and Q4 into four tiers
  (q4a DOT/MNRL, q4b CF+merchant blacklists, q4c prior-disputes, q4d ML+DCH+Min-SR).
  The monolithic forms exceed the client cap, and the Q3 OR-match defeated the semi-join.
* Long chunks (q3a, q3b, q4c) scan network-wide. HTTP read timeout is 600s (10 min).
"""
import json, os, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_DIR = os.path.join(HERE, "redshift_sql")
CONFIG = os.path.expanduser("~/.claude/plugins/config/cf-analytics/config.json")

ORDER = ["q1_gmv", "q2_disputes", "q3_cross_merchant",
         "q4a_dot_mnrl", "q4b_blacklists", "q4c_prior_disputes"]
ALIAS = {"q1": "q1_gmv", "q2": "q2_disputes", "q3": "q3_cross_merchant",
         "q4a": "q4a_dot_mnrl", "q4b": "q4b_blacklists", "q4c": "q4c_prior_disputes"}


def load_cfg():
    cfg = json.load(open(CONFIG))
    url = (cfg.get("metabase_url") or cfg.get("url") or "https://metabase.cashfree.com").rstrip("/")
    tok = cfg.get("metabase_session") or cfg.get("session") or cfg.get("token")
    db = cfg.get("redshift_db_id")
    if not tok or db is None:
        sys.exit("Missing metabase_session or redshift_db_id in " + CONFIG)
    return url, tok, db


def fill(sql, mid, days):
    slack = int(days) + 60
    return (sql.replace("__MID__", str(mid))
               .replace("__DAYS__", str(days))
               .replace("__SLACK__", str(slack)))


def run_one(name, mid, days, url, tok, db):
    path = os.path.join(SQL_DIR, name + ".sql")
    sql = fill(open(path).read(), mid, days)
    body = json.dumps({"database": db, "type": "native", "native": {"query": sql}}).encode()
    req = urllib.request.Request(url + "/api/dataset", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Metabase-Session", tok)
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=600)
        res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        res = json.loads(e.read().decode() or "{}")
    except Exception as e:
        print(f"\n### {name}: TRANSPORT ERROR after {time.time()-t0:.0f}s: {e}")
        return
    dt = time.time() - t0
    d = res.get("data", {})
    cols = [c.get("name") for c in d.get("cols", [])]
    rows = d.get("rows", [])
    print(f"\n### {name}  ({dt:.0f}s)")
    if res.get("error") or not cols:
        print("QUERY ERROR:", str(res.get("error", "(no cols returned)"))[:800])
        return
    print(" | ".join(cols)); print("-" * 80)
    for row in rows:
        print(" | ".join("NULL" if v is None else str(v) for v in row))
    print(f"({len(rows)} rows)")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    mid = sys.argv[1].strip()
    days = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].isdigit() else "180"
    which = sys.argv[3].lower() if len(sys.argv) > 3 else None
    url, tok, db = load_cfg()
    targets = [ALIAS[which]] if which in ALIAS else ORDER
    print(f"RiskShield Redshift run · MID {mid} · {days}d · {len(targets)} quer"
          f"{'y' if len(targets)==1 else 'ies'}")
    for name in targets:
        run_one(name, mid, days, url, tok, db)


if __name__ == "__main__":
    main()
