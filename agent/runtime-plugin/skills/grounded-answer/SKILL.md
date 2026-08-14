---
name: grounded-answer
description: Use before any factual answer that reaches a user, is saved to a stored record, enters a report, or influences a decision. Runs the four-step Chain-of-Verification cycle — draft, plan verification questions, answer them independently against graph and web sources, then revise. Skip for turns with no factual claims.
---

# Grounded Answer (Chain-of-Verification)

## When to run

Run this skill whenever your response will contain one or more **factual claims** — a company's founding year, a technology's TRL, a signal's relevance to a strategy, a patent's priority date, a relationship between two entities, a numeric value (counts, scores, revenues), a causal statement, a comparison. Skip for greetings, clarifying questions, acknowledgements, and plans that contain no claims.

## The four steps

### 1 — Draft

Write your proposed answer as you normally would. Keep it. Do not publish yet.

### 2 — Plan verification questions

For each factual claim in the draft, write one short verification question that a neutral third party could answer from a primary source. Aim for 3–8 questions per response. Examples:

- Claim: "Anthropic was founded in 2021" → Q: "In what year was Anthropic founded?"
- Claim: "Nvidia competes with AMD in AI accelerators" → Q: "What companies does Nvidia compete with in the AI accelerator market as of the past 12 months?"
- Claim: "LangChain uses Claude API" → Q: "Does LangChain integrate with the Claude API in its current release?"

Write each question **independently** — do not reference other questions. This prevents the model from anchoring on its own draft.

### 3 — Answer each question against sources

For each question, call the most appropriate tool to look up the answer:

- **Graph-resident facts** (entities, relationships, claims, assertions we own) → `searchKnowledgeGraph`, `getEntityContext`, `queryActiveEdges`, `getEntityTimeline`, `getEntityAssertions`, or Cypher via `executeCypher`.
- **Current / live-web facts** → `webSearch`, `webScrape`, or the `firecrawl` MCP.
- **Academic / primary-literature facts** → `searchPapers` (keyless: OpenAlex + Crossref + Semantic Scholar), then `resolveOpenAccess` when you need the full text rather than the abstract. The `arxiv` MCP is an additional source where it is wired.
- **Patent facts** → `searchPatents` (keyless).
- **Previously researched content** → `searchDocuments`, `getDocumentDetails`.

Reachability: `searchDocuments` and `getDocumentDetails` mount on `impulse-reports`, which only the **creator** profile carries. From any other profile treat them as a handoff and verify against `searchKnowledgeGraph` plus the live-web and primary-literature routes above — every one of those is reachable from every profile.

Record the raw source for each answer: URL, document ID, entity ID + property, or paper DOI. Do **not** paraphrase — quote or use structured fields.

### 4 — Revise

Compare the draft against the verified answers:

| Check                                          | Action                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Draft claim matches a verified answer          | Keep the claim, add a citation pointing to the source                                       |
| Draft claim contradicts a verified answer      | Replace with the verified claim + citation                                                  |
| Draft claim cannot be verified from any source | Soften to "likely / reportedly / as of YYYY, ..." **or** remove                             |
| Two sources disagree                           | State both + say which is more recent / authoritative. If irreconcilable, call out the gap. |

### Output shape

A revised answer that:

1. Contains only claims verified in step 3, or softened per the no-source rule.
2. Has inline citations for every factual claim (see `cite-ieee` skill for IEEE-style formatting when the output is a report).
3. Ends with a short **"Not verified:"** line if any draft claim had to be dropped for lack of source — tells the user what's missing so they can ask a follow-up.

## Anti-patterns (do not do)

- Do **not** answer verification questions from memory. If you did not call a tool, the answer is a guess, not a verification.
- Do **not** phrase verification questions in a way that echoes the draft. "Is it true that Anthropic was founded in 2021?" biases the answer. Use "In what year was Anthropic founded?".
- Do **not** skip step 3 because "the draft is obviously correct." The CoVe paper's F1 gain comes specifically from catching obvious-seeming hallucinations.
- Do **not** output intermediate steps by default. Only the revised answer goes to the user unless the user explicitly asks to see the verification trace.

## Reference

- Dhuliawala et al., "Chain-of-Verification Reduces Hallucination in Large Language Models," arXiv:2309.11495, 2023.
