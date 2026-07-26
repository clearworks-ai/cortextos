#!/usr/bin/env python3
"""
verify-fleet-context — per-agent context-economy verification harness.

test-on-staging discipline for the live fleet: measure the REAL per-agent context
numbers from transcripts + restart logs so the MCP diet / Fix 2 / PTY fix can be
proven by before/after diff, not asserted.

Usage:
  verify-fleet-context.py snapshot [--label baseline]   # capture all active agents -> /tmp/fleet-ctx-<label>.json
  verify-fleet-context.py diff baseline postdeploy       # compare two snapshots
  verify-fleet-context.py probe <agent> "<message>"     # inject a live turn, measure the context delta it costs
"""
import json, glob, os, sys, time, subprocess, statistics, re
from collections import defaultdict

PROJ = "/Users/joshweiss/.claude/projects"
LOGS = "/Users/joshweiss/.cortextos/cortextos1/logs"
ACTIVE = ["larry","frank2","pa","crm","muse","scout","maven","auditmaster",
          "automator","codexer","opencode","sage","ophir"]

def tdir(agent):
    ds = [d for d in glob.glob(f"{PROJ}/*agents-{agent}") if d.rstrip('/').endswith(agent)]
    return ds[0] if ds else None

def usage_tokens(u):
    return (u.get('input_tokens',0) + u.get('cache_read_input_tokens',0)
            + u.get('cache_creation_input_tokens',0))

def measure(agent):
    d = tdir(agent)
    out = {"agent": agent, "found": bool(d)}
    if not d:
        return out
    files = sorted(glob.glob(d+"/*.jsonl"), key=os.path.getmtime)
    recent = files[-1] if files else None
    floor = peak = last = 0
    per_turn_inject = 0          # documented-past-retrieval tokens (per-turn)
    mcp_reinjections = 0         # deferred_tools_delta events (MCP tool-list flap)
    if recent:
        first_seen = False
        for ln in open(recent, encoding='utf-8', errors='replace'):
            if 'deferred_tools_delta' in ln:
                mcp_reinjections += 1
            if 'documented-past-retrieval' in ln:
                per_turn_inject += len(ln)//4
            try: e = json.loads(ln)
            except: continue
            u = (e.get('message') or {}).get('usage')
            if u:
                t = usage_tokens(u)
                if not first_seen: floor = t; first_seen = True
                peak = max(peak, t); last = t
    # restart cadence today (UTC date rollover accepted; both 07-25/07-26 count as "today")
    clog = f"{LOGS}/{agent}/crashes.log"
    today_restarts = 0; gaps = []
    if os.path.exists(clog):
        ts = []
        for ln in open(clog, encoding='utf-8', errors='replace'):
            m = re.match(r'(2026-07-2[56])T([\d:]+).*planned-restart', ln)
            if m:
                today_restarts += 1
                try: ts.append(time.mktime(time.strptime(m.group(1)+m.group(2),'%Y-%m-%d%H:%M:%S')))
                except: pass
        ts.sort()
        gaps = [(ts[i+1]-ts[i])/60 for i in range(len(ts)-1)]
    out.update({
        "bootstrap_floor_tok": floor,
        "peak_ctx_tok": peak,
        "last_ctx_tok": last,
        "per_turn_retrieval_inject_tok": per_turn_inject,
        "mcp_toollist_reinjections": mcp_reinjections,
        "restarts_today": today_restarts,
        "median_gap_min": round(statistics.median(gaps),1) if gaps else None,
        "sessions_today": sum(1 for f in files if time.strftime('%Y-%m-%d',time.localtime(os.path.getmtime(f))) in ('2026-07-25','2026-07-26')),
    })
    return out

def snapshot(label):
    rows = [measure(a) for a in ACTIVE]
    path = f"/tmp/fleet-ctx-{label}.json"
    json.dump({"label":label,"agents":rows}, open(path,"w"), indent=2)
    print(f"{'agent':12s} {'floor':>7s} {'peak':>7s} {'per-turn':>9s} {'mcp-reinj':>9s} {'restarts':>8s} {'gap_min':>7s}")
    for r in rows:
        if not r.get("found"): print(f"{r['agent']:12s}  (no transcript)"); continue
        print(f"{r['agent']:12s} {r['bootstrap_floor_tok']:>7,} {r['peak_ctx_tok']:>7,} "
              f"{r['per_turn_retrieval_inject_tok']:>9,} {r['mcp_toollist_reinjections']:>9} "
              f"{r['restarts_today']:>8} {str(r['median_gap_min']):>7}")
    print(f"\nsaved -> {path}")

def diff(a, b):
    A = {r['agent']:r for r in json.load(open(f"/tmp/fleet-ctx-{a}.json"))['agents']}
    B = {r['agent']:r for r in json.load(open(f"/tmp/fleet-ctx-{b}.json"))['agents']}
    print(f"{'agent':12s} {'floor Δ':>14s} {'mcp-reinj Δ':>14s} {'gap_min':>16s}")
    for ag in ACTIVE:
        x,y = A.get(ag,{}),B.get(ag,{})
        if not x.get('found') or not y.get('found'): continue
        df = y['bootstrap_floor_tok']-x['bootstrap_floor_tok']
        dm = y['mcp_toollist_reinjections']-x['mcp_toollist_reinjections']
        print(f"{ag:12s} {x['bootstrap_floor_tok']:>6,}→{y['bootstrap_floor_tok']:<6,}({df:+,}) "
              f"{x['mcp_toollist_reinjections']:>3}→{y['mcp_toollist_reinjections']:<3}({dm:+}) "
              f"{str(x['median_gap_min']):>6}→{str(y['median_gap_min']):<6}")

def probe(agent, msg):
    before = measure(agent)
    print(f"[probe] {agent} before: floor={before.get('bootstrap_floor_tok')} last={before.get('last_ctx_tok')}")
    subprocess.run(["cortextos","notify-agent",agent,msg], check=False)
    print(f"[probe] injected '{msg}' — waiting 45s for the agent to take the turn...")
    time.sleep(45)
    after = measure(agent)
    print(f"[probe] {agent} after:  last={after.get('last_ctx_tok')}  Δ={after.get('last_ctx_tok',0)-before.get('last_ctx_tok',0):+} tok for one turn")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv)>1 else "snapshot"
    if cmd == "snapshot": snapshot(sys.argv[2] if len(sys.argv)>2 else time.strftime("%H%M"))
    elif cmd == "diff": diff(sys.argv[2], sys.argv[3])
    elif cmd == "probe": probe(sys.argv[2], sys.argv[3])
    else: print(__doc__)
