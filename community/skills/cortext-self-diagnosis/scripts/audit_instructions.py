#!/usr/bin/env python3
"""
audit_instructions.py — inventory an agent's instruction surface and flag the
mechanical defects: context budget, dead references, duplicated directives,
skill-description collisions, date-anchored staleness, emphasis inflation.

    python3 audit_instructions.py                          # audit cwd
    python3 audit_instructions.py --workspace ~/agents/opsbot
    python3 audit_instructions.py --workspace . --json

Read-only. It never edits anything.

It finds what a machine can find. The judgment calls — whether two individually
reasonable rules can both hold, whether a block earns its size — are yours, and
references/behavioral-audit.md walks them. Treat the output as a map of where to
look, not a verdict.
"""

import argparse, json, os, re, sys
from collections import defaultdict

BOOTSTRAP = ["CLAUDE.md", "AGENTS.md", "SOUL.md", "IDENTITY.md", "SYSTEM.md",
             "USER.md", "GUARDRAILS.md", "GOALS.md", "TOOLS.md", "HEARTBEAT.md",
             "ONBOARDING.md", "MEMORY.md"]
CONFIGS = ["config.json", "goals.json", ".claude/settings.json"]

# ~4 chars/token is the usual rough conversion for English prose.
CHARS_PER_TOKEN = 4
DEFAULT_WINDOW = 200_000

IMPERATIVE = re.compile(
    r"^\s*(?:[-*+]|\d+\.)?\s*(?:\*\*)?(ALWAYS|NEVER|MUST|DO NOT|DON'T|AVOID|"
    r"REQUIRED?|ENSURE|ONLY|BEFORE YOU|CRITICAL|MANDATORY|CONSEQUENCE)\b",
    re.I)
EMPHASIS = re.compile(r"\b(ALWAYS|NEVER|MUST|CRITICAL|MANDATORY|CONSEQUENCE|IMPORTANT|REQUIRED)\b")
DATED = re.compile(r"\b(20\d{2}|Q[1-4]\s*20\d{2}|currently|for now|temporar\w*|"
                   r"until we|upcoming|this (?:week|month|quarter)|last (?:week|month|quarter))\b", re.I)
PATH_REF = re.compile(r"`([^`\n]*?\.(?:md|json|sh|py|ts|js))`|(?:^|\s)((?:\./|\.\./|~/)[\w./-]+)")
CMD_REF = re.compile(r"`(cortextos\s+[a-z-]+(?:\s+[a-z-]+)?)`")
# (?<!\d) keeps "100%" and "20%" in ordinary prose from reading as a threat.
THREAT = re.compile(r"((?<!\d)0%|zero percent|you (?:will )?(?:have )?fail|will be penali|"
                    r"effectiveness score|you are failing|unacceptable)", re.I)

# A "path" containing a variable, glob, or command substitution is a template the
# shell expands at runtime, not a literal that can be checked from here.
UNRESOLVABLE = re.compile(r"[${}<>()*?\[\]]|\$\(")


def read(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return None


def collect(ws, org):
    """Every file that shapes behavior, with its layer."""
    out = []
    for n in BOOTSTRAP + CONFIGS:
        p = os.path.join(ws, n)
        if os.path.isfile(p):
            out.append(("agent", n, p))
    for sub, layer in (("memory", "memory"), ("experiments", "agent")):
        d = os.path.join(ws, sub)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.endswith((".md", ".json")):
                    out.append((layer, f"{sub}/{f}", os.path.join(d, f)))
    sd = os.path.join(ws, ".claude", "skills")
    if os.path.isdir(sd):
        for s in sorted(os.listdir(sd)):
            p = os.path.join(sd, s, "SKILL.md")
            if os.path.isfile(p):
                out.append(("skill", f"skills/{s}", p))
    if org and os.path.isdir(org):
        for root, _, files in os.walk(org):
            if any(x in root for x in (".git", "node_modules")):
                continue
            for f in sorted(files):
                if f.endswith((".md", ".json")):
                    p = os.path.join(root, f)
                    out.append(("org", os.path.relpath(p, org), p))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default=".", help="agent workspace (default cwd)")
    ap.add_argument("--org", default=None, help="shared org/context dir (auto-detected)")
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW, help="context window for budget %%")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list-imperatives", action="store_true",
                    help="print every ALWAYS/NEVER/MUST line, grouped by file, for Pass B")
    a = ap.parse_args()

    ws = os.path.abspath(os.path.expanduser(a.workspace))
    if not os.path.isdir(ws):
        print(f"ERROR: no such workspace: {ws}", file=sys.stderr); sys.exit(2)

    org = a.org
    if org is None:
        for c in (os.path.join(ws, "..", "..", "context"),
                  os.path.expanduser("~/.cortextos/default/context"),
                  os.path.expanduser("~/.business-os/context")):
            if os.path.isdir(c):
                org = os.path.abspath(c); break
    org = os.path.abspath(os.path.expanduser(org)) if org else None

    files = collect(ws, org)
    if not files:
        print(f"No instruction files found under {ws}.")
        print("Point --workspace at the directory holding CLAUDE.md / AGENTS.md.")
        sys.exit(2)

    rows, imperatives, dupes = [], [], defaultdict(list)
    dead_paths, dead_cmds, stale, threats = [], [], [], []
    total_chars = 0
    skills = {}

    for layer, name, path in files:
        text = read(path)
        if text is None:
            continue
        chars, lines = len(text), text.count("\n") + 1
        total_chars += chars
        # Tone and directive analysis only makes sense on prose. A .json record
        # store contributes to the context budget but is data, not instruction —
        # scanning it for "pressure language" produces pure noise.
        prose = name.endswith(".md") or layer == "skill"
        rows.append({"layer": layer, "name": name, "lines": lines, "chars": chars,
                     "tokens": chars // CHARS_PER_TOKEN,
                     "emphasis": len(EMPHASIS.findall(text)) if prose else 0,
                     "mtime": os.path.getmtime(path)})

        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if not s or not prose:
                continue
            if IMPERATIVE.search(s):
                imperatives.append({"file": name, "line": i, "text": s[:150]})
                key = re.sub(r"[^a-z ]", "", s.lower())
                key = " ".join(key.split())[:70]
                if len(key) > 25:
                    dupes[key].append(f"{name}:{i}")
            if THREAT.search(s):
                threats.append({"file": name, "line": i, "text": s[:150]})
            if DATED.search(s):
                stale.append({"file": name, "line": i, "text": s[:150]})

        base = os.path.dirname(path)
        skills_root = os.path.join(ws, ".claude", "skills")
        for m in PATH_REF.finditer(text):
            ref = m.group(1) or m.group(2)
            if not ref or ref.startswith("http") or UNRESOLVABLE.search(ref):
                continue
            if not ("/" in ref or ref.endswith((".md", ".json"))):
                continue
            # Try the plausible bases before calling it dead: alongside the file,
            # from the workspace root, and under .claude/skills (where docs
            # habitually write "tasks/SKILL.md" meaning the sibling skill).
            cands = [os.path.expanduser(ref)] if ref.startswith("~") else [
                os.path.join(base, ref), os.path.join(ws, ref), os.path.join(skills_root, ref)]
            if not any(os.path.exists(c) for c in cands):
                dead_paths.append({"file": name, "ref": ref})
        for m in CMD_REF.finditer(text):
            dead_cmds.append(m.group(1))

        if layer == "skill":
            fm = re.match(r"^---\n(.*?)\n---", text, re.S)
            desc = ""
            if fm:
                d = re.search(r'description:\s*"?(.*?)"?\s*\n(?:[a-z_]+:|$)', fm.group(1), re.S)
                desc = " ".join(d.group(1).split()) if d else ""
            skills[name] = desc

    tokens = total_chars // CHARS_PER_TOKEN
    pct = tokens / a.window * 100
    dupes = {k: v for k, v in dupes.items() if len(v) > 1}

    # Skill-description overlap: shared salient words are a cheap proxy for
    # "these two could plausibly claim the same request".
    STOP = set("the a an and or of to for use when this that with your you it is are be on in "
               "if not do use using used skill agent user should can will from as at by".split())
    overlaps = []
    keys = list(skills)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            wa = {w for w in re.findall(r"[a-z]{4,}", skills[keys[i]].lower()) if w not in STOP}
            wb = {w for w in re.findall(r"[a-z]{4,}", skills[keys[j]].lower()) if w not in STOP}
            if not wa or not wb:
                continue
            shared = wa & wb
            jac = len(shared) / len(wa | wb)
            if jac > 0.18 and len(shared) >= 4:
                overlaps.append({"a": keys[i], "b": keys[j], "score": round(jac, 2),
                                 "shared": sorted(shared)[:8]})
    overlaps.sort(key=lambda x: -x["score"])

    result = {"workspace": ws, "org": org, "files": len(rows), "tokens": tokens,
              "window_pct": round(pct, 1), "rows": rows, "duplicates": dupes,
              "dead_paths": dead_paths, "stale": stale, "threats": threats,
              "skill_overlaps": overlaps, "imperatives": len(imperatives)}

    if a.json:
        print(json.dumps(result, indent=2)); return

    if a.list_imperatives:
        # Grouped by file so conflicting rules from different layers sit near
        # each other — the point of Pass B is reading them as a set.
        print(f"\n{len(imperatives)} imperative lines — read as a set, not line by line.")
        print("Ask: can all of these hold at once, in the situation being described?\n")
        cur = None
        for im in imperatives:
            if im["file"] != cur:
                cur = im["file"]
                print(f"\n── {cur}")
            print(f"  {im['line']:>5}  {im['text']}")
        print()
        return

    print(f"\nInstruction Surface — {ws}")
    if org:
        print(f"shared org context: {org}")
    print()

    print(f"  {len(rows)} files   ~{tokens:,} tokens   ~{pct:.0f}% of a {a.window//1000}k window\n")
    if pct > 25:
        print("  Past ~25% of the window is spent before the first user message.")
        print("  Expect unreliable adherence to whatever sits late in the context.\n")

    by_layer = defaultdict(int)
    for r in rows:
        by_layer[r["layer"]] += r["tokens"]
    print("  by layer:")
    for k, v in sorted(by_layer.items(), key=lambda x: -x[1]):
        print(f"    {k:<8} ~{v:>7,} tokens")
    print()

    print("  largest files (these are re-read every boot):")
    for r in sorted(rows, key=lambda x: -x["tokens"])[:8]:
        print(f"    {r['tokens']:>6,} tok  {r['lines']:>5} ln  {r['name']}")
    print()

    def section(title, items, fmt, limit=12, note=None):
        if not items:
            return
        print(f"  ── {title} ({len(items)}) ──")
        if note:
            print(f"  {note}")
        for x in items[:limit]:
            print("    " + fmt(x))
        if len(items) > limit:
            print(f"    … {len(items)-limit} more")
        print()

    section("Repeated directives", list(dupes.items()),
            lambda kv: f"{', '.join(kv[1])}\n        \"{kv[0][:64]}…\"",
            note="Same rule in several places — each copy is future contradiction surface.")

    section("Broken references", dead_paths,
            lambda x: f"{x['file']}  →  {x['ref']}",
            note="Referenced path does not resolve. The agent will try, fail, and improvise.")

    section("Skill description overlap", overlaps,
            lambda x: f"{x['score']}  {x['a']} ↔ {x['b']}\n        shared: {', '.join(x['shared'])}",
            limit=8,
            note="Overlapping descriptions make skill selection a coin flip.")

    section("Pressure language", threats,
            lambda x: f"{x['file']}:{x['line']}  {x['text'][:90]}",
            limit=8,
            note="Threats and scores reliably produce over-compliance, not better work.")

    section("Date-anchored language", stale,
            lambda x: f"{x['file']}:{x['line']}  {x['text'][:90]}",
            limit=10,
            note="Was true once. Check whether it still is.")

    hot = sorted([r for r in rows if r["emphasis"] > 12], key=lambda x: -x["emphasis"])
    section("Emphasis inflation", hot,
            lambda r: f"{r['emphasis']:>4} markers  {r['name']}",
            limit=8,
            note="When every rule is critical, none of them are.")

    print(f"  {len(imperatives)} imperative lines across the surface.")
    print("  Whether they can all hold at once is a judgment call no scanner makes —")
    print("  that is Pass B in references/behavioral-audit.md.")
    print("  To read them as a set (works on any platform):\n")
    print("    python3 audit_instructions.py --list-imperatives")
    print()


if __name__ == "__main__":
    main()
