#!/usr/bin/env bash
# Orchestrator-run Layer-1 verification of the written-back plan (Python side).
# Materialises every labelled block into a fresh detached throwaway worktree and runs
# the suites/selftests there. Exit codes captured BARE (never piped). Usage:
#   verify-materialised.sh <plan.md> <out.json>
set -uo pipefail
PLAN="$1"; OUT="$2"
S=/private/tmp/claude-501/-Users-joshweiss-code-cortextos/cae12226-d674-4173-af86-d7fe5cbba2d7/scratchpad
TREE="$S/orch-verify-tree"
REPO=/Users/joshweiss/code/cortextos
BRANCH=feat/client-state-gmail-v1-build
rm -rf "$TREE"; git -C "$REPO" worktree prune
git -C "$REPO" worktree add --detach "$TREE" "$BRANCH" >/dev/null 2>&1; rc_wt=$?
echo "worktree add rc=$rc_wt tip=$(git -C "$TREE" rev-parse --short HEAD)"
python3 "$S/g0-compile.py" "$PLAN" "$TREE" > "$S/orch-g0.log" 2>&1; rc_g0=$?
echo "g0-compile rc=$rc_g0 $(grep blocks: "$S/orch-g0.log")"
cd "$TREE" || exit 9
npm ci --no-audit --no-fund > "$S/orch-npm-ci.log" 2>&1; rc_npm=$?; echo "npm ci rc=$rc_npm"
A=docs/pipeline/run-artifacts/client-state-gmail-v1
chmod +x $A/*.sh $A/*.py $A/shims/* 2>/dev/null
export CLIENT_STATE_REPO_ROOT="$TREE"
# apply the plan's retirements (Step 5 `git rm` lines) — the materialiser only writes files
for f in $(grep -oE "git rm( -f)? [^ \`]+" "$PLAN" | awk '{print $NF}' | sort -u); do rm -f "$TREE/$f" && echo "retired: $f"; done
python3 -m pytest scripts/brain/tests -q -p no:cacheprovider > "$S/orch-pytest.log" 2>&1; rc_py=$?
PYSUM=$(tail -1 "$S/orch-pytest.log")
echo "pytest rc=$rc_py :: $PYSUM"
bash $A/g1-count-delta.sh --selftest > "$S/orch-g1.log" 2>&1; rc_g1=$?
bash $A/g4-check.sh --selftest > "$S/orch-g4.log" 2>&1; rc_g4=$?
bash $A/cron-precheck.sh --selftest > "$S/orch-cron.log" 2>&1; rc_cron=$?
bash $A/test-ops-shims.sh > "$S/orch-shims.log" 2>&1; rc_shims=$?
CLIENT_STATE_REPO_ROOT="$TREE" bash $A/mutation-check.sh > "$S/orch-mut.log" 2>&1; rc_mut=$?
mkdir -p "$S/orch-g4"; cp $A/g4/*.json "$S/orch-g4/" 2>/dev/null
MUTSUM=$(python3 - <<'PY'
import json,glob
rows=0;green=0;bad=[]
for f in glob.glob("/private/tmp/claude-501/-Users-joshweiss-code-cortextos/cae12226-d674-4173-af86-d7fe5cbba2d7/scratchpad/orch-g4/*guards.json"):
    d=json.load(open(f))
    for k,v in (d.items() if isinstance(d,dict) else []):
        if not isinstance(v,dict): continue
        rows+=1
        ok=all(v.get(x) is True for x in ("control_green","mutation_applied","mutated_red"))
        green+=ok
        if not ok: bad.append(k)
print(f"rows={rows} green={green} not_green={bad}")
PY
)
echo "g1-selftest rc=$rc_g1  g4-selftest rc=$rc_g4  cron-selftest rc=$rc_cron  shims rc=$rc_shims  mutation rc=$rc_mut :: $MUTSUM"
SHA=$(shasum -a 256 "$PLAN" | cut -c1-64)
python3 - "$OUT" "$SHA" "$rc_wt" "$rc_g0" "$rc_py" "$PYSUM" "$rc_g1" "$rc_g4" "$rc_cron" "$rc_shims" "$rc_mut" "$MUTSUM" <<'EOF'
import json,sys,datetime
a=sys.argv
json.dump({"kind":"orchestrator-materialised-verification","at":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
 "plan_sha256":a[2],"worktree_add_rc":int(a[3]),"g0_compile_rc":int(a[4]),"pytest_rc":int(a[5]),"pytest_summary":a[6],
 "g1_selftest_rc":int(a[7]),"g4_selftest_rc":int(a[8]),"cron_selftest_rc":int(a[9]),"shims_rc":int(a[10]),"mutation_rc":int(a[11]),"mutation_summary":a[12],
 "note":"TS edits (Tasks 16-17) are OLD/NEW snippets not applied by this harness; TS coverage = opus G0a round-3 empirical run (anchors matched once, vitest 7+6, tsc 0). Mutation TS rows may report not-applied here."},
 open(a[1],"w"),indent=2)
EOF
cd "$REPO"; git worktree remove --force "$TREE" >/dev/null 2>&1; git worktree prune
echo "torn down: $(git worktree list | grep -c orch-verify-tree) remaining"
[ "$rc_g0" -eq 0 ] && [ "$rc_py" -eq 0 ] && [ "$rc_g1" -eq 0 ] && [ "$rc_g4" -eq 0 ] && [ "$rc_cron" -eq 0 ] && [ "$rc_shims" -eq 0 ] && exit 0
exit 1
