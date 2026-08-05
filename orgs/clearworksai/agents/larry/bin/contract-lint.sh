#!/bin/bash
# Contract-lint.sh — validates I/O contract compliance for P2 rollout skills
# Exits 0 only if all 18 skills pass contract checks

set -euo pipefail

# Hardcoded array of 18 unique P2 rollout skills (from MASTER-BUILD-PLAN.md lines 128-161)
# 25 job-rows map to 18 unique skills (some skills cover multiple jobs)
SKILLS=(
  "meeting-intelligence-engineer"
  "knowledge-base"
  "deal-debrief-analyst"
  "followup-coordinator"
  "call-prep-researcher"
  "inbox-manager"
  "proposal-writer"
  "pricing-analyst"
  "delivery-status-reporter"
  "client-onboarding-manager"
  "billing-manager"
  "pipeline-operations-manager"
  "records-administrator"
  "client-portal-manager"
  "customer-success-manager"
  "company-research-analyst"
  "vertical-analyst"
  "playbook-writer"
)

PASS_COUNT=0
FAIL_COUNT=0
FAILING_SKILLS=()

for skill in "${SKILLS[@]}"; do
  # Resolve SKILL.md path (runtime-loaded global first, then repo fallback)
  REPO_SKILL="/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/${skill}/SKILL.md"
  GLOBAL_SKILL="/Users/joshweiss/.claude/skills/${skill}/SKILL.md"
  
  SKILL_PATH=""
  if [[ -f "$GLOBAL_SKILL" ]]; then
    SKILL_PATH="$GLOBAL_SKILL"
    if [[ -f "$REPO_SKILL" ]] && ! diff -q "$REPO_SKILL" "$GLOBAL_SKILL" >/dev/null; then
      echo "DIVERGENCE: $skill repo copy differs from loaded copy — grading loaded copy, but repo copy may contain unmerged fixes" >&2
    fi
  elif [[ -f "$REPO_SKILL" ]]; then
    SKILL_PATH="$REPO_SKILL"
  else
    echo "FAIL: $skill — SKILL.md not found"
    ((FAIL_COUNT++))
    FAILING_SKILLS+=("$skill (missing)")
    continue
  fi
  
  # Check for I/O Contract heading
  if ! grep -q "## I/O Contract" "$SKILL_PATH"; then
    echo "FAIL: $skill — missing ## I/O Contract heading"
    ((FAIL_COUNT++))
    FAILING_SKILLS+=("$skill (no contract)")
    continue
  fi
  
  # Check for forbidden strings
  if grep -q "knowledge/company.md" "$SKILL_PATH"; then
    echo "FAIL: $skill — contains forbidden path knowledge/company.md"
    ((FAIL_COUNT++))
    FAILING_SKILLS+=("$skill (forbidden path)")
    continue
  fi
  
  if grep -q "interview" "$SKILL_PATH" | grep -q "layout"; then
    echo "FAIL: $skill — contains interview layout reference"
    ((FAIL_COUNT++))
    FAILING_SKILLS+=("$skill (interview layout)")
    continue
  fi
  
  echo "PASS: $skill"
  ((PASS_COUNT++))
done

echo ""
echo "Results: $PASS_COUNT PASS, $FAIL_COUNT FAIL"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo ""
  echo "Failing skills:"
  for failing in "${FAILING_SKILLS[@]}"; do
    echo "  - $failing"
  done
  exit 1
fi

exit 0
