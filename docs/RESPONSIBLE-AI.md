# Responsible AI

This document describes the engineering posture of the Radarist `0.1.0`
prototype. It is not legal advice, a regulatory classification, a compliance
certification, or a guarantee about a third-party model.

## Purpose

Radarist helps an operator research technologies and organizations, review
relationships, place technologies on a radar, and draft reports. It does not
train a foundation model. Optional features send prompts to model or research
providers configured by the operator.

## Human review is required

AI-generated text, scores, relationships, classifications, citations, images,
and reports are drafts. The operator must:

1. open and evaluate cited sources;
2. check entity identity, relation direction, and freshness;
3. resolve contradictory evidence;
4. approve or reject proposals explicitly;
5. review an artifact before sharing or acting on it.

Confidence is a prioritization heuristic, not a probability or truth claim.
Read [Confidence, evidence, and feedback](guides/confidence-evidence-and-feedback.md)
for the review model.

## Defaults and controls

- seeded exploration needs no provider key;
- background automation is paused by default;
- proposal automation and build missions are default-off;
- mission and provider paths have configurable budgets and limits;
- MCP and application tools apply authentication and permissions;
- run records preserve model, usage, and artifact context where available.

These controls reduce risk but do not prevent every hallucination, privacy
mistake, provider outage, or unexpected charge.

## Data and providers

Only send information you are permitted to share with the configured provider.
Do not use production secrets, personal data, confidential customer material,
or restricted sources in prototype evaluations. Review the provider's terms,
retention policy, regional processing, model behavior, and pricing yourself.

Operators are responsible for source licenses, access restrictions, privacy,
and downstream use of generated artifacts. Radarist does not claim that every
research path detects rights reservations or verifies publisher independence.

## Prohibited reliance

Do not use Radarist as the sole basis for decisions about a natural person or
for employment, credit, insurance, eligibility, safety, law enforcement,
medical, legal, or similarly consequential decisions.

## Experimental sandbox

Build missions and their sandbox are experimental, default-off, and not
qualified or supported in v0.1. The sandbox can resolve mutable external tools
and is unsuitable for sensitive or reproducible work in this release.

## Feedback

Use the product's review controls to approve, reject, or dismiss proposals.
Report unsafe or misleading behavior through the issue process in
[Support](../SUPPORT.md), without including credentials or private data.
