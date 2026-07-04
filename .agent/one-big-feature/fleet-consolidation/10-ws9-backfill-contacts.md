# WS9 Backfill Delta — Clearpath → CRM

_Generated: 2026-07-03 15:45 — Read-only analysis. No changes made._

## Counts

| | Count |
|---|---|
| CRM agent contacts (current) | 291 |
| Clearpath contacts (deduplicated across 2 orgs) | 357 |
| Already in CRM (email or name match) | 255 |
| **Delta (would be added by backfill)** | **102** |
| → Strong (name + real email + meeting source) | 4 |
| → Weak (name present; email encrypted — unusable) | 65 |
| → Junk (no real name, demo data, bots, usernames) | 33 |

## Key Finding

**65 of the 102 delta contacts have encrypted emails.** Clearpath encrypts emails at rest in the `email_extraction` pipeline. Without the decryption key, these contacts would import into the CRM with no usable email address. All 65 weak contacts fall into this category.

The actionable backfill is **Strong tier only: 4 contacts.**

---

## STRONG Tier (4 contacts)

Name + real email + real meeting interaction. Safe to import.

| Name | Email | Org | Last Activity | Source | Note |
|---|---|---|---|---|---|
| Susan Ryan | susan@russianriverkeeper.org | — | 2026-02-26 | meeting_speaker | Josh already has contacts at this org |
| Melissa Njoo | melissa@rethinkmedia.org | — | 2026-02-26 | meeting_speaker | Josh already has Eva @ Rethink |
| Regina Torrizo | reginat@logictcg.com | — | 2026-02-26 | meeting_speaker | Ex-employer (Logic TCG) |
| Ashlyn Robinson | ashlyn@russianriverkeeper.org | — | 2026-02-26 | meeting_speaker | Josh already has contacts at this org |

---

## WEAK Tier (65 contacts)

**All have encrypted emails.** These cannot be imported with usable contact info. Subcategories:

- 58 × `email_extraction`: one-touch email contacts, interaction_count=1, no org
- 6 × meeting-sourced: appeared in a meeting but email was encrypted
- 1 × manual: Outwords Archive (encrypted email)

### Weak — Meeting/Calendar sourced (6)

| Name | Email | Org | Last Activity | Source |
|---|---|---|---|---|
| Sawantmrinmayi Sawant | [encrypted] | — | 2026-05-03 | calendar_attendee |
| Amara- The Outwords Archive | [encrypted] | Outwords Archive | 2026-03-19 | manual |
| Dgoodman | [encrypted] | — | 2026-06-02 | meeting_participant |
| Klalonde | [encrypted] | — | 2026-03-30 | meeting_participant |
| Jessica | [encrypted] | — | 2026-03-26 | meeting_participant |
| Brian | [encrypted] | — | 2026-03-26 | meeting_participant |
| Kcollins | [encrypted] | — | 2026-03-26 | meeting_participant |

### Weak — Email extraction (58 of 65)

All one-touch email contacts with encrypted addresses, no org, no meeting linkage. Showing all 58:

| Name | Last Seen | Interactions |
|---|---|---|
| Bijeoma Ijeoma | 2026-07-03 | 3 |
| Bassem Dawod | 2026-07-03 | 1 |
| Michelle Woo | 2026-07-02 | 1 |
| Elize Simon | 2026-07-02 | 1 |
| Courtney Colclasure | 2026-07-01 | 1 |
| Esther Deutsch | 2026-07-01 | 1 |
| Dr. Bob Newport | 2026-06-29 | 1 |
| Josh Claros | 2026-06-28 | 1 |
| Mohsin Abbas | Inspizer | 2026-06-24 | 1 |
| Clearworks.AI | 2026-06-24 | 1 |
| Blaise Clair | 2026-06-22 | 1 |
| Tadia Taylor | 2026-06-18 | 1 |
| Mitch Kranitz | 2026-06-11 | 1 |
| Kristin Noelle | 2026-06-10 | 1 |
| Sherie Wylie | 2026-05-28 | 1 |
| Gabriel Onutu | 2026-05-25 | 1 |
| Rene Hernández | 2026-05-22 | 1 |
| Verónica Zárate | 2026-05-20 | 1 |
| bounces+59410227-d81f-josh=clearworks.ai | 2026-04-29 | 1 |
| bounce+v2+6efeb1.f62ae5.1777653169.BAABAQWspYil9VTliMZJ0YozQopGL6dzZw~josh=clearworks.ai | 2026-04-28 | 1 |
| bounce+v2+6efeb1.f62ae5.1777650793.BAABAQV1K-KPXfPZYTJFvYvFik_LNC_JYw~josh=clearworks.ai | 2026-04-28 | 1 |
| bounces+51791150-3e3f-josh=clearworks.ai | 2026-04-28 | 1 |
| bounces+35008234-4555-josh=clearworks.ai | 2026-04-28 | 1 |
| bounces+55734814-8c8d-josh=clearworks.ai | 2026-04-28 | 1 |
| bounces+josh=clearworks.ai | 2026-04-28 | 1 |
| bounces+34206967-0aab-josh=clearworks.ai | 2026-04-28 | 1 |
| bounces+25999526-6dca-josh=clearworks.ai | 2026-04-28 | 1 |
| bounce+2578c5.64c17d-josh=clearworks.ai | 2026-04-27 | 1 |
| bounces+50943564-6ab5-josh=clearworks.ai | 2026-04-27 | 1 |
| bounces+53521849-01c9-josh=clearworks.ai | 2026-04-26 | 1 |
| bounce+1e0a6c.e2989d-josh=clearworks.ai | 2026-04-26 | 1 |
| bounce-3577775-732-22088-josh=clearworks.ai | 2026-04-26 | 1 |
| bounce+a2c1da.282148-josh=clearworks.ai | 2026-04-25 | 1 |
| bounce+v2+6efeb1.f62ae5.1777381293.BAAKAAXrKuPXzbucDAFI0o4JPRI0wn_naQ~josh=clearworks.ai | 2026-04-25 | 1 |
| bounce+bfbea6.c73c88-josh=clearworks.ai | 2026-04-24 | 1 |
| bounce+24aba3.3c0cbb-josh=clearworks.ai | 2026-04-24 | 1 |
| bounces+9405544-4dfc-josh=clearworks.ai | 2026-04-23 | 1 |
| bounce+49839b.074921-josh=clearworks.ai | 2026-04-23 | 1 |
| Joy from The AI Exchange | 2026-04-06 | 1 |
| hollybieler | 2026-04-06 | 1 |
| Aaron Hodge Silver | 2026-04-06 | 1 |
| Josh Cohen | 2026-04-05 | 1 |
| Sophie Beck | 2026-04-05 | 1 |
| Nishant from Fireflies.ai | 2026-04-04 | 1 |
| Jean Elejalde | 2026-04-03 | 1 |
| Khurram Rais (Egnyte MSP Support) | 2026-04-03 | 1 |
| harminder | 2026-04-02 | 1 |
| insiders | 2026-04-02 | 1 |
| Jonathan Romig | 2026-04-02 | 1 |
| Joe from Zapier | 2026-04-01 | 1 |
| Order - Hetzner Online GmbH | 2026-04-01 | 1 |
| Dotty Kaminsky | 2026-03-31 | 1 |
| Diane Templin | 2026-03-31 | 1 |
| Alex Levin | 2026-03-30 | 1 |
| alexmlevin | 2026-03-30 | 1 |
| grandamenium/claude-remote-manager | 2026-03-28 | 1 |
| Anthony Brathwaite | 2026-03-27 | 1 |
| Elie at Inbox Zero | 2026-03-23 | 1 |

---

## JUNK Tier (33 contacts)

Drop. Reasons: demo data, automated senders, username-style names, Josh himself, product names.

| Name | Email | Reason |
|---|---|---|
| markj@jensen-architects.com | [encrypted] | no real name |
| josh@clearworks.ai Weiss | josh@clearworks.ai | no real name |
| ap | [encrypted] | no real name |
| brian.murray@agilenet.works | [encrypted] | no real name |
| Sarah Johnson | sarah.johnson@demo.clearpath.ai | demo email address (demo.clearpath.ai) |
| mewilliams | [encrypted] | automated/product name, not a person |
| Info | [encrypted] | automated/product name, not a person |
| "Williams | [encrypted] | automated/product name, not a person |
| barbaragirlone | [encrypted] | automated/product name, not a person |
| Lifecycle X | [encrypted] | automated/product name, not a person |
| omi from omi | [encrypted] | automated/product name, not a person |
| TradeCanyon Events | [encrypted] | automated/product name, not a person |
| help | [encrypted] | username-style name, not a real person |
| richard | [encrypted] | username-style name, not a real person |
| marketing | [encrypted] | username-style name, not a real person |
| vnd | [encrypted] | username-style name, not a real person |
| bounce-IK7DRWU3O22EBKF3IOIXPBULUU.130015 | [encrypted] | username-style name, not a real person |
| bounce-kl_28596190921-kl_101101kq7mwz2kpx1t1a-h-3d59145b21=2 | [encrypted] | username-style name, not a real person |
| Anorman | [encrypted] | username-style name, not a real person |
| Scripe | [encrypted] | username-style name, not a real person |
| projects | [encrypted] | username-style name, not a real person |
| Kimpositive | [encrypted] | username-style name, not a real person |
| Support | [encrypted] | username-style name, not a real person |
| jessicapuano | [encrypted] | username-style name, not a real person |
| robin | [encrypted] | username-style name, not a real person |
| 1Password | [encrypted] | username-style name, not a real person |
| stjepan | [encrypted] | username-style name, not a real person |
| Goodword | [encrypted] | username-style name, not a real person |
| veryshinything | [encrypted] | username-style name, not a real person |
| Jlococo | [encrypted] | username-style name, not a real person |
| jrpiraneo | [encrypted] | username-style name, not a real person |
| 11079842002009075886294429431440ver2 | [encrypted] | username-style name, not a real person |
| andy.runyan | [encrypted] | username-style name, not a real person |

---

## Decision Guide

| Option | What imports | Risk |
|---|---|---|
| **Backfill all 102** | 4 real contacts + 65 unusable (no email) + 33 junk | Pollutes CRM with 98 low-value rows |
| **Backfill Strong only** | 4 contacts with real emails from meetings | Low — but review notes below |
| **Skip backfill** | Nothing | Zero noise |

### Notes on the 4 Strong contacts
- **Susan Ryan + Ashlyn Robinson** (Russian Riverkeeper) — Josh already has Jaime Neary, Rob Schwenker, Ariel Majorana @ RRK in the CRM. Adding two more could be useful if they have distinct roles.
- **Melissa Njoo** (Rethink Media) — Josh already has Eva Galanes-Rosenbaum @ Rethink. Melissa is secondary; check if she's relevant before importing.
- **Regina Torrizo** (LogicTCG) — Josh's ex-employer. Should this be in his CRM at all?

### On the encrypted weak tier
If Josh wants to backfill the email_extraction contacts, the correct path is to ask Clearpath to export decrypted emails (or expose a decryption endpoint) — not to import them with blank email fields.