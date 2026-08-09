# 521 live deployment certificate — 2026-08-08

## Deployment

- Service: `seiu521-dashboard`
- Railway deployment: `77465907-88d3-4e88-b434-0edcb356fedd`
- Status: `SUCCESS`
- Source: `origin/main` at `6538ef0` (merged auth form-parser fix)
- Auth flow verified: `GET /auth/callback` → `POST /auth/verify` with a short-lived token → authenticated `GET /api/stats`.

## Live API result

The authenticated production API returned:

| month | received | matchable | complete | partial | missing | failed |
|---|---:|---:|---:|---:|---:|---:|
| 2026-05 | 6 | 6 | 6 | 0 | 0 | 0 |
| 2026-06 | 90 | 83 | 83 | 4 | 0 | 3 |

2026-04 is absent from the dashboard response.

## Reproduction and reconciliation

Running the exact deployed `origin/main` `getMonthlySubmissionStats()` against the production
database reproduced the same `6` and `90` loop counts. The raw production breakdown was:

- 112 rows in the April–June date window;
- 95 raw June, 12 raw May, 5 raw April;
- after dashboard exclusions: 92 June and 6 May;
- June's 92 included rows collapse to 87 loops, with four legitimate identity groups (three
  two-member groups and one three-member group), yielding the deployed month totals.

## Gate decision

The deployment and reproducibility gates are **GREEN**. The historical Larry handoff target
(June 45/43/43/1/0/1 and April/May absent) is **STALE** relative to the current production
dataset and is not silently accepted as the current target. The data-certification gate remains
**RED** until the 521 owner explicitly re-baselines the expected KPI snapshot or identifies the
additional 45 June rows as invalid production data. No destructive data changes were made.
