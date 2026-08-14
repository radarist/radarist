---
name: analyze-patent-claims
description: Use for one patent filing or granted patent — "US11234567", "EP3456789B1", PCT/WIPO application, "patent-pending", freedom-to-operate, prior art, IPC/CPC code. Parses independent and dependent claims into a structured PatentEvent. For assignee concentration and white space across many filings use `read-patent-landscape` instead.
---

# Analyze Patent Claims

Reading patents like a patent examiner, not like a press release.

## When to invoke

Trigger on text containing:

- Patent numbers: `US\d{7,8}[A-Z]?\d?`, `EP\d{7,8}[A-Z]?\d?`, `WO\d{4}/\d{6}`, `CN\d{9}[A-Z]?`
- `patent pending`, `patent application`, `patent filing`, `IP filing`
- `independent claim`, `dependent claim`, `claim construction`
- `prior art`, `anticipated by`, `obvious over`
- `IPC code`, `CPC classification`, `USPTO`, `EPO`, `WIPO`
- `freedom to operate` / `FTO`

Skip for trademark filings (different IP type), design patents (visual, not functional — different claims structure), and non-patent IP (trade secrets, copyrights).

## Output schema

```json
{
  "event_type": "patent_event",
  "patent_number": "US11234567B2",
  "kind_code": "B2",
  "title": "System and method for ...",
  "priority_date": "2022-06-15",
  "filing_date": "2023-06-14",
  "publication_date": "2024-12-10",
  "grant_date": "2024-12-10",
  "assignee": "Example Corp",
  "inventors": ["Jane Doe", "John Smith"],
  "jurisdiction": "US",
  "patent_family_members": ["EP4123456A1", "WO2023/012345"],
  "ipc_codes": ["G06N 3/08", "G06F 18/21"],
  "cpc_codes": ["G06N 3/084", "G06F 18/2148"],
  "independent_claim_count": 3,
  "dependent_claim_count": 17,
  "independent_claim_1_gist": "A method comprising: receiving ...; processing ...; outputting ...",
  "claim_transition_language": "comprising",
  "claimed_invention_domain": "machine learning, RAG retrieval",
  "prior_art_signals": ["cites US10987654", "non-final office action mentions arXiv:2104.xxxxx"],
  "status": "granted | pending | expired | abandoned",
  "source_url": "https://patents.google.com/patent/...",
  "source_grade": "A1",
  "confidence": 93
}
```

## Procedure

### 1 — Identify jurisdiction from the number

- `US\d{7,8}` → USPTO granted; kind code `B1/B2/E/H` = granted; `A1/A2/A9` = published application
- `EP\d{7}` → EPO; `A1/A2` = application; `B1/B2` = granted
- `WO\d{4}/\d{6}` → WIPO PCT international application (not a grant — designates national phase)
- `CN\d{9}` → China National IP Administration
- `JP\d{7,8}` → Japan Patent Office
- `KR\d{7}` → Korea IPO

PCT (WO) is a filing, not a grant — tag status=`pending` and note which national phases have been entered.

### 2 — Parse the claims

Every patent has **independent claims** and **dependent claims**. The independent claims define the invention's full scope; dependent claims narrow it with additional limitations.

- Read Claim 1 first. It is the **broadest** claim and defines the outer boundary of the invention.
- Count independent claims (usually 1–4). Count dependent claims (usually 10–30).
- Identify the **claim transition language**:
  - `"comprising"` — **open** transition; the invention covers anything that includes the listed elements, plus more
  - `"consisting of"` — **closed** transition; the invention is exactly the listed elements, nothing else
  - `"consisting essentially of"` — **middle ground**; allows minor additions that don't materially change the invention

The transition word determines how infringement is judged. Open claims are much broader.

### 3 — Summarize Claim 1 in one sentence

Distill Claim 1 into a single "A method/system/apparatus comprising: X, Y, Z" summary. This is the _inventive step_ — what the applicant claims is new.

Do NOT paraphrase prose from the abstract or title — those are marketing. Read the actual claim text.

### 4 — Classify via IPC/CPC

IPC = International Patent Classification (8-character, WIPO-maintained). CPC = Cooperative Patent Classification (USPTO+EPO, finer-grained).

Common relevant classes for Radarist's domain:

- `G06N` — computing based on biological models / neural networks
- `G06F` — electric digital data processing
- `G16` — information and communication technology for specific application areas (H = healthcare, Y = bio)
- `G01N` — investigating or analyzing materials
- `A61K` — preparations for medical purposes

Capture all listed codes — don't cherry-pick.

### 5 — Prior-art signals

These are patent-internal clues about competing or adjacent work:

- **Cited references** — patents cited on the cover page. Either citations by the applicant or by the examiner. Lots of citations = crowded art.
- **Non-final office action history** (visible in file wrapper via Public PAIR / EP Register) — what the examiner objected to. If the examiner rejected based on specific prior art, note it.
- **Family members rejected in other jurisdictions** — e.g. granted US but rejected EPO → the claim language may need to be narrower.

### 6 — Flag deal-relevance

Does this patent affect Radarist's entities?

- If the assignee is a Company in our graph → link patent to Company
- If the IPC/CPC domain matches an existing Technology → link patent to Technology
- If the invention directly mentions a named competitor's product → flag for Linker review (potential infringement signal)

### 7 — Grade the source via `rate-source-admiralty`

- **A1**: USPTO / EPO / WIPO official publications, Google Patents (which proxies official data)
- **A2**: Lexology, IPWatchdog, Managing IP — patent-specialist press
- **B2-C2**: generic tech news re-reporting a patent filing
- **D3+**: speculation blogs that claim to have seen a patent but don't cite the number

## Anti-patterns

- Do **not** read the title or abstract as the invention. Patent abstracts are marketing; the **claims** are the law.
- Do **not** treat "comprising" and "consisting of" as synonyms. Different infringement tests.
- Do **not** treat a WIPO publication as a grant. PCT applications are not patents — they are international placeholder filings.
- Do **not** cherry-pick IPC codes. The full set tells you the real domain mix.
- Do **not** conflate patent families. A US continuation, an EP divisional, and a Chinese national phase are _different_ patents with potentially different claims, even in the same family.

## Reference

- USPTO Manual of Patent Examining Procedure (MPEP), §2111 (claim construction), §2141 (obviousness), §2143 (KSR framework).
- European Patent Convention (EPC), Art. 54 (novelty) and Art. 56 (inventive step).
- Cooperative Patent Classification scheme: https://www.cooperativepatentclassification.org/
- WIPO Patent Landscape Reports methodology: https://www.wipo.int/patentscope/en/programs/patent_landscapes/
- Pairs with `detect-funding-round` (IP-heavy startup fundraise pairs with IP filings), `triangulate-sources` (a patent claim + a product launch + a hire signals execution), and `research-technology` (patents enrich Technology entities).

## Radarist binding

Step 6 already says to link and flag — these are the calls that do it:

- `searchPatents` — the filing and its family.
- `searchEntities` — resolve the assignee to a Company entity.
- `captureEvidence` / `linkDocumentToEntity` — claim text is prime evidence material.
- `proposeVerifiedRelation` — assignee-to-technology and competitor-overlap edges.
- `recordAgentObservation` — reachable from every profile; the fallback route for both of the above.

Reachability: `captureEvidence` and `linkDocumentToEntity` mount on `impulse-reports`, which only the **creator** profile carries. Scout, evaluator and strategist run this skill and cannot call those two — treat them as a handoff, and record the claim text with `recordAgentObservation` instead. `proposeVerifiedRelation` mounts on `impulse-entities`, which every profile carries, so propose the candidate edge directly and it stays pending until a human decides. Do not substitute `createRelationWithEvidence`: that writes the assertion directly rather than proposing it, which is a different decision authority.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
