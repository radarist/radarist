---
name: verify-citations
description: Use after `cite-ieee` produces a References section, or when a report contains DOIs, arXiv IDs, or URLs to check before publishing. Validates each identifier against its canonical format and surfaces ones that should be replaced. For checking whether a stated value is true use `grounded-fact-check` instead.
---

# Verify Citations

Catch malformed, fabricated, or decayed citations before they reach a report.

## Scope

This skill runs **format-level** validation with regex — no network calls, no external keys. It catches:

- Fabricated DOIs ("doi: 10.fake/xyz") that don't match the ISO 26324 format.
- Malformed arXiv IDs (wrong year, wrong category, missing version).
- Invalid ISBNs (wrong checksum).
- Malformed URLs (missing scheme, double slashes, whitespace).
- PubMed IDs outside the legitimate range.

It does NOT catch:

- DOIs that are correctly formatted but resolve to a different paper.
- URL link rot (page exists but content changed).
- Retracted papers (registered at Retraction Watch — a separate lookup).
- Preprints later published under a different venue.

For those deeper checks a separate `resolve-citations` skill would be needed with Crossref / arXiv API keys. That's out of scope here.

## The validation rules

### DOI (Digital Object Identifier)

**Format**: `10.NNNN/<suffix>` where the prefix is `10.` followed by 4+ digits, a `/`, then a suffix composed of any characters except whitespace.

**Regex**: `^10\.\d{4,}(\.\d+)*/\S+$`

Examples:

- `10.1038/s41586-023-06221-2` ✓ (Nature paper)
- `10.1109/CVPR52729.2023.01142` ✓ (IEEE conference)
- `10.fake/xyz` ✗ (prefix has no digits)
- `10.1038/paper with spaces` ✗ (whitespace in suffix)

### arXiv ID (new scheme since Apr 2007)

**Format**: `YYMM.NNNNN[vN]` — 4-digit YYMM, dot, 4 or 5 digit sequence, optional version.

**Regex**: `^\d{4}\.\d{4,5}(v\d+)?$`

Examples:

- `2309.11495` ✓ (CoVe paper)
- `2309.11495v2` ✓ (revision 2)
- `0705.0001` ✓ (edge case — first paper under new scheme)
- `2509.99999` ⚠︎ format valid but YYMM in the future — flag as suspect

### arXiv ID (old scheme, pre-Apr 2007)

**Format**: `<archive>[.<category>]/YYMMNNN`

**Regex**: `^([a-z\-]+)(\.[A-Z]{2})?/\d{7}$`

Examples:

- `cs.CL/0105023` ✓
- `math/0211123` ✓ (no category suffix allowed for old single-archive papers)

### PubMed ID (PMID)

**Format**: positive integer, typically 1–9 digits (PubMed IDs now exceed 40 million).

**Regex**: `^\d{1,9}$`

**Bounds check**: must be ≤ current PubMed upper bound (~45M as of 2026; assume 50M safe ceiling). Below 100 is suspicious (earliest PubMed entries).

### ISBN-13

**Format**: 13 digits, optionally hyphen-separated, starting `978` or `979`. Checksum: weighted sum of the first 12 digits (×1, ×3 alternating) plus check digit must be divisible by 10.

**Regex for format**: `^97[89][-\d]{10,14}$` then strip hyphens and compute checksum.

### ISBN-10

**Format**: 10 digits (or 9 + `X`), checksum: weighted sum of first 9 (×1 through ×9) plus check digit (0–10) mod 11 = 0.

### URL

**Format**: must include scheme + host. Whitespace inside is invalid. Consecutive slashes outside the scheme are invalid.

**Regex**: `^https?://[^\s/$.?#].\S*$`

Additional check: if the URL is marked `[Online]. Available:` per IEEE and the domain is a well-known ghost (`example.com`, `lorem-ipsum.net`, TLDs like `.example`), flag it.

## The procedure

1. **Parse the references section.** Each numbered entry `[N] ...` is one reference.
2. **Extract identifiers.** For each entry, look for:
   - `doi: 10....` or `https://doi.org/10....`
   - `arXiv:YYMM.NNNNN`
   - `PMID: NNNNN`
   - `ISBN: NNN-N-NN-NNNNNN-N`
   - URLs after `Available:` or in inline brackets
3. **Apply the regex for each.**
4. **Compute checksums** for ISBN variants.
5. **Emit a report** per citation:

```
[1] Dhuliawala et al., "Chain-of-Verification...", arXiv:2309.11495, 2023.
    ✓ arXiv ID format valid
    ✓ arXiv ID date plausible (Sep 2023)
    → PASS

[2] S. Reporter, "Article", *Publication*, 2024. [Online]. Available: https://example.com/article
    ✗ URL uses example.com — looks like a placeholder
    → REVIEW

[3] Smith, "Paper", *Journal*, vol. 5, no. 2, 2024. doi: 10.invalid-fake
    ✗ DOI prefix has no digits after '10.'
    → FAIL — fabricated DOI pattern
```

6. **Summarize at the end**: total / pass / review / fail. If any FAIL, invoke `abstain-or-escalate` to decide whether to drop the failing citations, search for replacements, or hold the report.

## Anti-patterns

- Do **not** report a DOI as valid just because it looks like one. Run the regex.
- Do **not** skip the YYMM plausibility check for arXiv. A future-dated arXiv ID is a hallucination tell.
- Do **not** fetch URLs in this skill. That's `resolve-citations` territory and requires keys.
- Do **not** auto-delete failing citations without surfacing them. Drop + notify.

## Reference

- ISO 26324:2012 — Information and Documentation — Digital Object Identifier System.
- arXiv identifier scheme: https://info.arxiv.org/help/arxiv_identifier.html
- ISO 2108:2017 — ISBN.
- RFC 3986 — URI Generic Syntax.

## Radarist binding

**Route** (minimum viable = the 1 marked ★):

1. ★ `resolveOpenAccess` — **keyless**, and it resolves a DOI or arXiv id to a real record. This upgrades the skill from "the string looks like a DOI" to "the DOI exists and points where the report claims". The "format-only, no extra keys" limitation in older guidance is obsolete.
2. `formatCitations` — the platform's own citation formatter; prefer it to hand-rolled renumbering.
3. `searchPapers` — when an identifier resolves to nothing, search the title before declaring it broken.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named below, then record the gap with `recordKnowledgeGap` rather than inventing the value.
