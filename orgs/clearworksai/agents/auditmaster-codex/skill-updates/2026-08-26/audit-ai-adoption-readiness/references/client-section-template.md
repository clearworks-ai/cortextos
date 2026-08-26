# Client section and evidence-ledger template

Use this reference while building `04a-ai-operating-environment-and-adoption.md` and its internal evidence ledger.

## Internal evidence ledger

The JSON ledger is the citation source of truth. It is not client-facing.

```json
{
  "schema_version": 1,
  "client_slug": "sample-client",
  "project_id": "project-identifier",
  "generated_on": "2026-08-26",
  "assessment_areas": [
    {
      "area": "tools_in_use",
      "status": "evidenced",
      "notes": "Named tools and uses were reported in two interviews.",
      "evidence": [
        {
          "evidence_client": "sample-client",
          "source_path": "auditos://project/sample-client/interviews/INT-001",
          "citation": "INT-001 / Operations Lead / [12:14]",
          "confidence": "reported"
        }
      ]
    }
  ],
  "findings": [
    {
      "id": "AIR-001",
      "area": "admin_ownership",
      "state": "gap",
      "title": "Administrative ownership is not assigned",
      "detail": "Interview evidence did not identify a named owner for account changes or offboarding.",
      "evidence": [
        {
          "evidence_client": "sample-client",
          "source_path": "auditos://project/sample-client/interviews/INT-002",
          "citation": "INT-002 / Executive Director / [31:09]",
          "confidence": "reported"
        }
      ]
    }
  ],
  "recommendations": [
    {
      "id": "AIR-R001",
      "timing": "now",
      "title": "Assign an AI tool administrator",
      "action": "Name the person responsible for access changes, settings review, and offboarding.",
      "owner": "Executive sponsor",
      "dependencies": [],
      "addresses": ["AIR-001"]
    }
  ],
  "evidence_gaps": [
    {
      "question": "Are model-training controls disabled for company workspaces?",
      "owner": "AI tool administrator"
    }
  ],
  "optional_support": null
}
```

Allowed assessment-area keys:

- `tools_in_use`
- `admin_ownership`
- `sso_provisioning_offboarding`
- `privacy_retention_training_connectors`
- `company_data_use`
- `approved_use_human_review`
- `role_training`
- `adoption_sticking_points`
- `use_case_intake_ownership`
- `prioritized_fixes`

Each area uses `status: evidenced | not_established`. A `not_established` area needs an evidence-gap question rather than a negative finding.

## Client-facing section

```markdown
# AI operating environment and adoption

## What we found

[Two or three factual paragraphs. Name which tools and operating practices were confirmed, reported, or not established. Avoid a maturity label.]

## Current operating picture

| Area | Current state | Confidence | Evidence |
|---|---|---|---|
| Tools in use | ... | Confirmed / Reported / Inferred | INT-### / role / [MM:SS] |
| Ownership and access | ... | ... | ... |
| Privacy and data settings | ... | ... | ... |
| Data entering AI tools | ... | ... | ... |
| Use and human review rules | ... | ... | ... |
| Training and adoption | ... | ... | ... |
| New-use-case ownership | ... | ... | ... |

## Gaps to address

### [Plain finding title]

**Current state:** ...

**Gap:** ...

**Why it matters:** [Specific workflow, access, data, review, or adoption consequence supported by evidence.]

**Evidence:** ...

## Recommended actions

| Timing | Action | Owner | Dependency | Addresses |
|---|---|---|---|---|
| Now | ... | ... | None / named dependency | AIR-### |
| Later | ... | ... | ... | AIR-### |

## Questions to close

- [Question] — owner: [role]
```

## Client-facing pre-flight

- The title and headings are plain statements.
- No internal file paths, secrets, cross-client references, or process notes appear.
- Each finding distinguishes current state from gap.
- Each recommendation is bounded, timed, owned, and linked to an evidenced finding.
- `Not established from available evidence` is used when configuration or policy was not checked.
- Optional ongoing support appears only if evidence supports an ownership or cadence gap, and it is no more than one short paragraph.

