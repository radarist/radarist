---
name: detect-funding-round
description: Use for a capital raise — "Series A/B/C/D", "seed round", "raised $X million/billion", "closed a funding round", "announces financing", "valued at $X". Parses it into a structured FundingEvent — amount, stage, date, lead investor, participants, post-money valuation.
---

# Detect Funding Round

Turn unstructured funding news into a structured event record.

## When to invoke

Trigger on text containing:

- `Series [A-Z]` or `Series [A-Z]-\d` (e.g. "Series B-2")
- `seed round`, `pre-seed`, `bridge round`, `growth round`, `crossover round`
- `raised $[\d.]+ [MmBbKk]` / `raised [\d.]+ (million|billion)`
- `closed (a|its) (\$[\d.]+[MmBbKk]|[\d.]+ (million|billion)) (Series|round|financing)`
- `post-money valuation (of|at) \$`
- `led by <investor>` in the same paragraph as a capital amount

Skip for passing mentions ("Y Combinator-backed startup") that don't announce a specific round.

## Output schema

```json
{
  "event_type": "funding_round",
  "company_name": "Anthropic",
  "stage": "Series E",
  "amount_usd": 3500000000,
  "amount_currency": "USD",
  "announced_date": "2025-03-03",
  "close_date": "2025-03-03",
  "post_money_valuation_usd": 61500000000,
  "lead_investors": ["Lightspeed Venture Partners"],
  "participating_investors": ["Salesforce Ventures", "Menlo Ventures"],
  "use_of_proceeds": "compute scaling, enterprise sales expansion",
  "source_url": "https://...",
  "source_grade": "B2",
  "confidence": 92
}
```

Every field except `company_name`, `event_type`, and `source_url` is optional. Omit what the source doesn't say — do not fabricate a lead investor, a valuation, or a use-of-proceeds.

## Parsing procedure

### 1 — Normalize the amount

`$47M` → `47000000`. `$1.2B` → `1200000000`. `€10 million` → still USD-normalize? No — keep currency separate (`amount_currency: "EUR"`).

Beware:

- `$47M-$50M` → use the midpoint `48500000` and mark `confidence` lower.
- "up to $X" → treat as the cap; mark `confidence` < 70.
- Currency symbols: `$` is ambiguous between USD, CAD, AUD, SGD. Only commit to `USD` if context confirms.

### 2 — Identify the stage

Map common variants:

- "Series A round" → `"Series A"`
- "seed financing" / "seed round" → `"Seed"`
- "pre-seed" → `"Pre-seed"`
- "bridge" → `"Bridge"`
- "secondary" / "tender offer" → `"Secondary"`
- "growth equity" / "late-stage" → `"Growth"`
- IPO / direct listing / SPAC → `"Public (IPO|Direct|SPAC)"`

If the article says "latest round" without a stage name, leave `stage` blank and rely on the amount + date.

### 3 — Extract valuation separately from amount

`$3.5B at $61.5B post-money` — these are different fields. Never put the valuation in `amount_usd`.

Look for "post-money," "pre-money," "valuing at $X." If only "valued at $X" is mentioned with no qualifier, default to `post_money_valuation_usd` and note the ambiguity in `confidence`.

### 4 — Identify investors

- **Lead** = the investor who "led the round" / who "priced the round" / who is named first in most headlines.
- **Participants** = everyone else.

If no lead is explicitly named, leave `lead_investors: []` — do not guess.

### 5 — Date

Announcement date is typically the article's publish date. Close date may differ and is often in the article text ("which closed on <date>"). When both are present, use both.

### 6 — Grade the source via `rate-source-admiralty`

Funding news grades:

- **A1-B2**: SEC Form D filing, company-issued press release on primary domain, Reuters, FT, Bloomberg
- **C2-D3**: aggregator (Crunchbase without primary citation, TechCrunch re-hash without byline)
- **F6**: rumor blog, anonymous Twitter post

### 7 — Emit the event

Confidence uses an integer **0–100** scale, not 0–1.

If `confidence >= 75` and the source is Admiralty ≤ B3:

- Create a Signal of type `funding_news` with the structured payload.
- Attach to the Company entity if resolvable (via `searchEntities`).
- If Company doesn't exist in the graph yet, surface the new-company signal for triage.

If `confidence < 75` or source is lower-graded, surface but do not auto-apply — call `abstain-or-escalate` or add `needs_review: true`.

## Anti-patterns

- Do **not** combine amount and valuation. `$3.5B raised` and `$61.5B valuation` are separate numbers.
- Do **not** guess the stage. "Series A" and "seed" are different rounds; wrong stage propagates to comp analysis.
- Do **not** auto-convert currency without explicit context. `$47M` from a European source may be EUR.
- Do **not** take aggregator re-reporting as primary. Walk the citation chain back to the company statement or SEC filing.
- Do **not** strip "led by" — it carries most of the signal about who the round's momentum is from.

## Reference

- SEC Form D filing: https://www.sec.gov/forms (primary source for US private rounds).
- Crunchbase, PitchBook: secondary aggregators, useful cross-check but not primary.
- Pairs with `rate-source-admiralty` (grade the source) and `triangulate-sources` (require ≥2 independent sources for high-confidence auto-apply).

## Radarist binding

Form D is the authoritative record of a US private raise — prefer it to the press release:

- `searchSecFilings` — amount, date and filer, straight from the filing.
- `searchEntities` — resolve the company to an existing entity before creating a duplicate.
- `addCompanyNote` / `createVerifiedSignal` — persist the event against the entity.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
