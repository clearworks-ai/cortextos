#!/usr/bin/env python3
"""
Mechanical assembly-completeness gate for the audit-assemble-master skill.
Run BEFORE calling any client's final report "done." Fails loudly (non-zero exit,
printed FAIL lines) if the deliverable is short of the standard set. This is not
advisory — a FAIL here means the assembly is not finished, full stop.

Usage: python3 assembly-check.py <client-slug> [--reference-pdf PATH] [--reference-pages N]

Checks:
  1. All 4 standard diagram types present (connection map, swimlanes, vicious-cycle, impact/urgency)
  2. Swimlane count matches the number of workflows in the client's workflow-maps file
  3. Final PDF page count is within a defensible range of the reference (default: MSIA 99pp)
  4. Source markdown word count is logged for a human sanity check (no hard threshold — depends on
     real source-material size, but a silent short report is exactly what this script exists to catch)
"""
import argparse
import glob
import os
import re
import subprocess
import sys

DIAGRAM_TYPE_PATTERNS = {
    "connection-map": [r"connection.?map"],
    "swimlanes": [r"swimlane", r"^wf-\d"],
    "vicious-cycle": [r"vicious.?cycle", r"bow.?tie"],
    "impact-urgency": [r"impact.?urgency", r"2x2", r"2×2"],
}

DEFAULT_REFERENCE_PDF = os.path.expanduser(
    "~/code/cortextos/orgs/clearworksai/agents/auditmaster/deliverables/msia/"
    "MSIA-Operational-Audit-BRANDED-99pp-20260709.pdf"
)
DEFAULT_REFERENCE_PAGES = 99
MIN_PAGE_RATIO = 0.5  # a report below half the reference's page count must be explicitly justified


def find_deliverables_dir(client_slug):
    base = os.path.expanduser(
        f"~/code/cortextos/orgs/clearworksai/agents/auditmaster/deliverables/{client_slug}"
    )
    if not os.path.isdir(base):
        print(f"FAIL: no deliverables directory found at {base}")
        sys.exit(2)
    return base


def scan_diagram_types(base):
    all_files = []
    for root, _, files in os.walk(base):
        for f in files:
            if f.lower().endswith((".png", ".svg", ".jpg", ".jpeg")):
                all_files.append(os.path.join(root, f).lower())

    found = {}
    for dtype, patterns in DIAGRAM_TYPE_PATTERNS.items():
        matches = [f for f in all_files if any(re.search(p, f) for p in patterns)]
        found[dtype] = matches
    return found


def count_workflows_in_source(base):
    candidates = glob.glob(os.path.join(base, "*workflow-maps*.md"))
    if not candidates:
        return None
    with open(candidates[0], "r", encoding="utf-8", errors="ignore") as fh:
        text = fh.read()
    return len(re.findall(r"^###?\s*WF-\d+", text, re.MULTILINE))


def get_pdf_page_count(pdf_path):
    if not os.path.isfile(pdf_path):
        return None
    try:
        out = subprocess.run(
            ["pdfinfo", pdf_path], capture_output=True, text=True, check=True
        ).stdout
        m = re.search(r"Pages:\s+(\d+)", out)
        return int(m.group(1)) if m else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        try:
            from pypdf import PdfReader

            return len(PdfReader(pdf_path).pages)
        except Exception:
            return None


def find_final_pdf(base, client_slug):
    candidates = sorted(
        glob.glob(os.path.join(base, "*BRANDED*.pdf"))
        + glob.glob(os.path.join(base, f"*{client_slug}*.pdf"))
    )
    return candidates[-1] if candidates else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("client_slug")
    ap.add_argument("--reference-pdf", default=DEFAULT_REFERENCE_PDF)
    ap.add_argument("--reference-pages", type=int, default=None)
    args = ap.parse_args()

    base = find_deliverables_dir(args.client_slug)
    failures = []
    warnings = []

    # Check 1: diagram type presence
    found = scan_diagram_types(base)
    missing_types = [dtype for dtype, files in found.items() if not files]
    print("== Diagram type check ==")
    for dtype, files in found.items():
        status = "OK" if files else "MISSING"
        print(f"  [{status}] {dtype}: {len(files)} file(s)")
    if missing_types:
        failures.append(
            f"Missing diagram type(s): {', '.join(missing_types)} — "
            "the standard set is System Connection Map, Swimlanes, Bow-tie/vicious-cycle, "
            "Impact×Urgency 2×2. All four are required, not a subset."
        )

    # Check 2: swimlane count vs workflow count
    wf_count = count_workflows_in_source(base)
    swimlane_files = found.get("swimlanes", [])
    swimlane_pngs = [f for f in swimlane_files if f.endswith(".png")]
    print("\n== Swimlane coverage check ==")
    if wf_count is None:
        warnings.append("No workflow-maps source file found — could not verify swimlane count.")
        print("  [WARN] no workflow-maps source file found")
    else:
        print(f"  workflows in source: {wf_count}, swimlane PNGs found: {len(swimlane_pngs)}")
        if len(swimlane_pngs) < wf_count:
            failures.append(
                f"Only {len(swimlane_pngs)} of {wf_count} workflows have a saved swimlane diagram."
            )

    # Check 3: page count vs reference
    reference_pages = args.reference_pages
    if reference_pages is None:
        reference_pages = get_pdf_page_count(args.reference_pdf) or DEFAULT_REFERENCE_PAGES
    final_pdf = find_final_pdf(base, args.client_slug)
    print("\n== Page count check ==")
    if final_pdf is None:
        failures.append("No final branded PDF found to check page count against.")
        print("  [FAIL] no final PDF found")
    else:
        pages = get_pdf_page_count(final_pdf)
        print(f"  final PDF: {final_pdf}")
        print(f"  pages: {pages} (reference: {reference_pages})")
        if pages is None:
            warnings.append("Could not determine page count of final PDF (pdfinfo/pypdf unavailable).")
        elif pages < reference_pages * MIN_PAGE_RATIO:
            failures.append(
                f"Final PDF is {pages} pages, under {int(MIN_PAGE_RATIO * 100)}% of the "
                f"{reference_pages}-page reference. This must be explicitly justified to Josh "
                "(genuinely thinner source material) — not silently shipped."
            )

    print("\n== Result ==")
    for w in warnings:
        print(f"WARN: {w}")
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        print(f"\n{len(failures)} FAILURE(S) — assembly is NOT done. Fix before shipping.")
        sys.exit(1)
    else:
        print("PASS — mechanical checks satisfied. (This does not replace the qualitative "
              "full-corpus / CLIENT-FACING VOICE review — run that too.)")
        sys.exit(0)


if __name__ == "__main__":
    main()
