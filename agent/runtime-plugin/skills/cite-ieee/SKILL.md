---
name: cite-ieee
description: Use when a report, research document, or long-form response carries three or more cited sources. Converts URLs, DOIs, arXiv IDs, paper titles, filings, and news articles into IEEE numbered-bracket inline citations plus a numbered References section.
---

# Cite IEEE

IEEE Editorial Style Manual — simplified for Radarist's four most common source types. When Creator or Strategist produces a report with cited sources, this skill produces the canonical numbered-bracket format and the properly-shaped reference list at the end.

## When to skip

Skip for short chat responses. Inline attribution of one or two links in prose is fine without the formal numbering machinery — reach for this only at three or more cited sources, or when the output is a document someone will cite in turn.

## The two outputs

### 1 — Inline markers

Every factual claim that depends on a source gets a numeric bracket after the claim:

```
Nvidia's data-center revenue reached $47.5B in Q4 FY2024 [1], a 409% year-over-year increase [1, 2].
```

Rules:

- Numbering starts at `[1]` and increments in **order of first appearance**. Subsequent references to the same source reuse the same number.
- Multiple sources for one claim combine inside the brackets: `[1, 2]` or `[3, 7, 9]` (not `[1][2]`).
- Consecutive numbers compress with an en-dash: `[2–5]` means "sources 2, 3, 4, and 5."
- Brackets go **before** terminating punctuation: `… 409% YoY [1, 2].` (not `… YoY. [1, 2]`).
- Put the bracket as close to the specific claim as possible — right after the number/name/quote it supports, not at the end of a long paragraph.

#### HTML output form (brand reports)

When the output is HTML (a Radarist brand report), every inline marker is an anchored link to its references-list entry — never a bare `<sup>`:

```html
<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>
```

The matching references-list entry carries the id the anchor targets, plus the **complete source URL as plain text**:

```html
<li id="ref-1">
  <span class="ref-num">[1]</span> A. Smith, "Title of paper," … —
  <span class="ref-source">https://example.com/full/path</span>
</li>
```

Print the whole URL, never a shortened host — the reader copies it to reach the source.

**Why the source is not a link.** Publication rejects any off-origin `href`, and the report viewer strips every non-fragment `href` before rendering inside a sandboxed frame. An `<a href="https://…">` therefore cannot survive: it fails publication, and even if it did the link would not be clickable. Same-document `#ref-N` anchors are the one link form that works, which is why every citation must resolve to exactly one entry id — publication rejects a dangling or duplicated reference target.

Markdown outputs keep the plain `[N]` bracket — no anchor machinery.

### 2 — References section

At the end of the document, a level-2 heading `## References` followed by a numbered list, one source per entry. Format per source type:

#### Journal article (most common for arXiv/peer-reviewed)

```
[1] A. Smith, B. Jones, and C. Lee, "Title of paper in sentence case," *Journal Name*, vol. 42, no. 7, pp. 123–145, 2024. doi: 10.1234/abc.5678.
```

- Up to six authors: all listed. Seven or more: first author "et al."
- Title in sentence case, in double quotes.
- Journal name in italics (markdown: `*…*`).
- Include DOI when present.

#### arXiv preprint

```
[2] A. Smith and B. Jones, "Title of paper," arXiv:2401.12345, 2024.
```

- No DOI required. arXiv ID alone resolves.
- If the paper has been subsequently published, use the journal format and append `originally arXiv:2401.12345`.

#### News article / blog post

```
[3] S. Reporter, "Article title in sentence case," *Publication Name*, Apr. 3, 2026. [Online]. Available: https://example.com/article
```

- Month in three-letter abbrev with period (Jan., Feb., Mar., …).
- `[Online]. Available: <URL>` for web sources.
- When the article has no byline, start with the publication: `*Publication Name*, "Title...," Apr. 3, 2026. …`.

#### Company / government filing

```
[4] Nvidia Corporation, "Form 10-K for fiscal year ended Jan. 28, 2024," U.S. Securities and Exchange Commission, Washington, DC, USA, Feb. 21, 2024. [Online]. Available: https://www.sec.gov/...
```

- Issuing entity as the author.
- Document type quoted, e.g. "Form 10-K," "U.S. Patent 9,123,456," "WIPO Patent Application PCT/US…".
- Include the filing/publication authority, its location, and the date of publication.

## Workflow

1. Walk the report top-to-bottom, collect every source cited in order of appearance.
2. Assign a number to each unique source (first appearance order).
3. Replace inline references with `[N]` markers per the rules above. For HTML outputs use the anchored form `<a class="cite-link" href="#ref-N"><sup class="cite">[N]</sup></a>` and give each references-list entry the matching `id="ref-N"`; markdown outputs keep plain `[N]`.
4. Emit the `## References` section with each entry fully formatted per its source type.
5. (Optional) Call the `verify-citations` skill if available, to DOI/arXiv-validate each reference before publishing.

## Anti-patterns

- Do **not** use `(Smith, 2024)` author-year style. That's APA — IEEE is numbered.
- Do **not** re-number if a source appears twice. `[1]` is always the same source; only new sources get new numbers.
- Do **not** omit the DOI when one exists. The DOI is the durable pointer; URLs rot.
- Do **not** paraphrase a source and leave it uncited. Either attribute or cut the sentence.
- Do **not** include personal communications as numbered references without the user's explicit OK — they're unverifiable and weaken the report.

## Reference

- IEEE Editorial Style Manual for Authors, 2020 Edition (current as of 2024). Section 9 "References," §10 "Reference Styles." IEEE Publication Services and Products Board.

## Radarist binding

- `formatCitations` — the platform's own citation formatter; prefer it to hand-rolled numbering and dedup.
- `resolveOpenAccess` — confirm a DOI or arXiv id resolves before it ships in a reference list.

The publication gate rejects hyperlinked `href` targets in reference entries on the release path. Follow the gate, not an example, if the two disagree.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
