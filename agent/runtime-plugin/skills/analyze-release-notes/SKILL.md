---
name: analyze-release-notes
description: Use for a release note, changelog, or version announcement — "v2.4 released", semver bump, "breaking changes", deprecation notice, or a CVE alongside a version. Parses it into a structured ReleaseEvent and grades signal strength for graph ingestion.
---

# Analyze Release Notes

Turn a release note into a structured, gradable signal.

## When to invoke

Trigger on text containing:

- `v\d+\.\d+(\.\d+)?` (semver) or `release notes`, `changelog`, `patch notes`
- `BREAKING CHANGE`, `deprecation`, `deprecated`, `removed`, `sunset`
- `CVE-\d{4}-\d+` or `security advisory` alongside a version
- Section headers like `## What's New`, `### Bug fixes`, `### Features`

Skip for marketing launch posts that describe a product but contain no version number or dated delta.

## Output schema

```json
{
  "event_type": "release",
  "project_name": "LangChain",
  "version": "0.3.0",
  "prior_version": "0.2.17",
  "semver_bump": "minor",
  "released_date": "2026-04-10",
  "breaking_changes": ["Removed deprecated ConversationalRetrievalChain; use RunnableWithMessageHistory"],
  "new_features": ["langchain-openai split into separate package"],
  "deprecations": ["initialize_agent (use create_react_agent instead)"],
  "bug_fixes": 12,
  "security_advisories": ["CVE-2026-12345"],
  "source_url": "https://...",
  "source_grade": "A1",
  "signal_strength": "high"
}
```

`signal_strength`:

- **high**: major bump OR any breaking change OR security advisory
- **medium**: minor bump with new features
- **low**: patch bump, bug fixes only

## Procedure

### 1 — Identify the version and prior version

Parse `v?X.Y.Z` from the heading or URL. If the note compares to a prior version ("since 0.2.17"), capture it. Determine `semver_bump` by diffing:

- X → major
- Y → minor
- Z → patch

For calendar-versioned projects (e.g. `2026.04.01`), set `semver_bump: "calver"` and skip the comparison.

### 2 — Partition the body by section

Release notes usually have sections. Map common headings:

- "Breaking changes" / "Breaking" / "⚠ BREAKING" → `breaking_changes[]`
- "Features" / "What's new" / "Added" → `new_features[]`
- "Deprecations" / "Deprecated" → `deprecations[]`
- "Bug fixes" / "Fixed" → count into `bug_fixes` (int)
- "Security" / CVE mentions → `security_advisories[]`

If no section headers, scan line-by-line for keyword triggers (BREAKING, deprecated, CVE-) and categorize heuristically.

### 3 — Extract breaking changes verbatim

For each breaking change, capture the **one-sentence summary** and the **migration path** if given. Do not paraphrase — downstream tools match on the exact phrasing (e.g. the deprecated symbol name).

### 4 — Grade the source

Use `rate-source-admiralty`. Release notes grade:

- **A1**: GitHub release tag on the project's official repo, project's own docs domain
- **A2**: vendor-issued email to subscribers, package registry (npm, PyPI) release page
- **B2-C2**: third-party changelog aggregator (libraries.io, endoflife.date)
- **C3+**: blog rewrite of a release note

### 5 — Compute signal strength and emit

Apply the rubric in "Output schema" above. Emit as a Signal of type `release`:

```typescript
{
  type: "release",
  payload: { ...structured_release_event },
  confidence: admiralty_to_confidence(grade),
  links: [source_url],
  impact: signal_strength
}
```

Attach to the project's Technology entity if resolvable via `searchEntities`.

### 6 — Cross-link deprecations

For each deprecation, check if another entity in the graph `USES` the deprecated symbol. If yes, flag those users — this is the highest-value downstream signal (we know who will break).

## Anti-patterns

- Do **not** treat every release as high-signal. Patch bumps without breaking changes are noise.
- Do **not** skip the prior-version comparison. "What changed since" is the whole point.
- Do **not** fabricate missing sections. If the note has no deprecations section, emit `deprecations: []` — do not invent them.
- Do **not** drop security advisories into bug_fixes. CVEs are a separate axis and have their own downstream handling.

## Reference

- Semantic Versioning 2.0.0: https://semver.org/
- Keep a Changelog convention: https://keepachangelog.com/
- CVE format: https://cve.mitre.org/
- Pairs with `detect-funding-round` (both parse news into signals).

## Radarist binding

The highest-value step in this skill is a graph traversal:

- `getGraphNeighbors` / `queryGraph` — who `USES` the deprecated symbol? Those are the entities that will break, and that is the downstream signal worth emitting.
- `searchOssHealth` — release cadence context for whether this bump is routine or notable.
- `searchEntities` → `createVerifiedSignal` — attach the release to its technology.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
