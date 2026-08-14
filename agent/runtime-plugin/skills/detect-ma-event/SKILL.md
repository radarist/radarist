---
name: detect-ma-event
description: Use for a transaction — "acquired", "merger", "buyout", "takeover", "all-cash deal", "stock swap", "go-private", "carve-out", "definitive agreement". Parses it into a structured MAEvent — acquirer, target, consideration, deal value, close, jurisdictions, termination fee — and flags deal-structure risk.
---

# Detect M&A Event

Turn unstructured M&A news into a structured event record. Complement to `detect-funding-round` — that skill handles primary-market capital raises; this handles secondary-market transactions (change of control).

## When to invoke

Trigger on text containing:

- `acquir(e|es|ed|ing|ition)` next to a company name
- `merg(er|es|ed)`, `takeover`, `buyout`, `LBO`, `MBO`
- `all-cash deal`, `stock swap`, `stock-for-stock`, `mixed consideration`
- `go-private`, `take private`, `tender offer`, `schedule 14D`
- `divesting`, `carve-out`, `spin-off`, `spin-out`
- `letter of intent (LOI)`, `definitive agreement`, `merger agreement`

Skip for organic commercial partnerships (joint venture, licensing, OEM). Skip for internal reorganizations. Skip for primary fundraising → use `detect-funding-round`.

## Output schema

```json
{
  "event_type": "ma_event",
  "deal_type": "acquisition | merger | divestiture | spinoff | go_private",
  "acquirer_name": "Microsoft",
  "target_name": "Activision Blizzard",
  "deal_value_usd": 68700000000,
  "consideration_type": "cash | stock | mixed",
  "consideration_detail": "all-cash at $95.00/share",
  "implied_equity_value_usd": 68700000000,
  "enterprise_value_usd": 75400000000,
  "premium_pct": 45,
  "announced_date": "2022-01-18",
  "expected_close_date": "2023-06-30",
  "actual_close_date": "2023-10-13",
  "status": "announced | pending | closed | terminated | contested",
  "regulatory_jurisdictions": ["US-DOJ", "US-FTC", "EU-EC", "UK-CMA", "CN-SAMR"],
  "strategic_rationale": "gaming content for Xbox Game Pass; mobile reach via King",
  "termination_fee_usd": 3000000000,
  "risk_flags": ["antitrust-concern", "cross-border", "hostile-bid", "reverse-merger"],
  "source_url": "https://...",
  "source_grade": "A1",
  "confidence": 95
}
```

Every field except `event_type`, `deal_type`, `acquirer_name`, `target_name`, and `source_url` is optional. Omit what the source doesn't say — do not fabricate a termination fee or a regulatory list.

## Procedure

### 1 — Classify the deal type

| Language                             | Deal type                                         |
| ------------------------------------ | ------------------------------------------------- |
| "acquires all outstanding shares"    | `acquisition` (stock purchase)                    |
| "acquires assets of"                 | `acquisition` (asset purchase) — tag `asset-deal` |
| "merger of equals", "combines with"  | `merger`                                          |
| "divests", "sells {division} to"     | `divestiture`                                     |
| "spin-off", "spin-out", "separation" | `spinoff`                                         |
| "go-private", "take private", "LBO"  | `go_private`                                      |

Asset vs stock purchase is a critical distinction: asset deals usually don't transfer liabilities, stock deals do.

### 2 — Extract the consideration structure

Not the same as "deal value." Parse:

- **Consideration type**: cash / stock / mixed
- **Consideration detail**: `$95.00/share in cash`, `0.28 shares of Acquirer per Target share`, `$45 cash + 0.15 shares`, `earnout up to $500M tied to {milestone}`
- **Implied equity value**: `price per share × shares outstanding`. If only "deal valued at $X" is stated, capture as `enterprise_value_usd` and note the ambiguity in `confidence`.
- **Premium**: `(offer price − unaffected trading price) / unaffected trading price × 100`. The unaffected price is typically the day-before-rumor or day-before-announcement close.

### 3 — Dates and status

- **Announced date**: public announcement
- **Expected close**: from the press release ("subject to customary closing conditions, expected to close in H2 2026")
- **Actual close**: only present if the deal has closed
- **Status**: announced (just declared) / pending (regulatory review) / closed / terminated / contested (activist or counter-bid)

### 4 — Regulatory jurisdictions

List the antitrust authorities with material review power:

- `US-DOJ` / `US-FTC` — HSR filing threshold
- `EU-EC` — EU Merger Regulation thresholds
- `UK-CMA` — post-Brexit UK review
- `CN-SAMR` — Chinese antitrust
- `IN-CCI`, `BR-CADE`, `JP-JFTC`, `KR-KFTC` — the other big ones

If the deal size × geographic footprint exceeds thresholds, the jurisdiction should be on the list even if not mentioned in the press release.

### 5 — Risk flags

Emit from this controlled vocabulary:

- `antitrust-concern` — deal increases concentration above Herfindahl thresholds or has public statements from regulators
- `cross-border` — acquirer and target are in different jurisdictions with CFIUS / FDI review
- `hostile-bid` — tender offer launched without board approval
- `reverse-merger` — target's shareholders end up with majority of combined entity
- `sponsor-backed` — PE sponsor-led go-private (usually = higher leverage post-close)
- `activist-contested` — known activist campaign against the deal
- `regulatory-blocked-risk` — similar prior deals were blocked or remediated

### 6 — Grade the source via `rate-source-admiralty`

A1–B2: company 8-K / Schedule TO, EDGAR filing, Bloomberg/Reuters/FT/WSJ primary reporting.
C2–D3: trade-press aggregators without primary citation.
F6: anonymous blog, X/Twitter speculation.

### 7 — Emit

Confidence uses an integer **0–100** scale, not 0–1. If `confidence >= 80` and source ≤ B3, create a Signal of type `ma_event` with the structured payload; attach to the acquirer AND target Company entities. If confidence < 80 or lower-graded source, surface for human review with `needs_review: true`.

## Anti-patterns

- Do **not** combine deal value with premium. Deal value is absolute; premium is percentage over unaffected trading price — different fields.
- Do **not** mark the deal as closed because a press release says "agreed." Announced ≠ closed; use the status vocabulary.
- Do **not** skip the regulatory list. Cross-border deals without antitrust jurisdictions surfaced are a known source of follow-up noise.
- Do **not** treat an LOI (letter of intent) as a definitive agreement. LOIs are non-binding in most jurisdictions — use status=`announced` and confidence < 60.

## Reference

- SEC filings: Schedule TO (tender offer), Schedule 13D (5%+ stake), 8-K Item 1.01 (definitive agreement), Form S-4 (stock consideration registration).
- M&A taxonomy references: Skadden Arps / Davis Polk annual M&A review publications.
- Antitrust pre-clearance checklists: Morrison Foerster cross-border HSR guides.
- Pairs with `detect-funding-round` (primary vs secondary — mutually exclusive), `rate-source-admiralty` (source grade), and `triangulate-sources` (high-value events require ≥2 independent confirmations).

## Radarist binding

8-K and merger proxies carry deal value and terms verbatim:

- `searchSecFilings` — consideration, value, termination fee, expected close.
- `searchEntities` — resolve both acquirer and target to entities.
- `proposeVerifiedRelation` — an acquisition implies a graph edge; propose it rather than leaving the fact prose-only.
- `recordAgentObservation` — reachable from every profile; the fallback route when the proposal call is not.

Reachability: `proposeVerifiedRelation` and `listPendingProposedRelations` mount on `impulse-entities`, which every profile carries — propose the candidate edge directly and it stays pending until a human decides. Do not substitute `createRelationWithEvidence`: that writes the assertion directly instead of proposing it for review. If a proposal call fails, record the candidate with `recordAgentObservation` (`observationType: 'connection'`) and state it in the output for triage rather than dropping it.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
