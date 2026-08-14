# High-Level Architecture

Radarist `0.1.0` is a local-first Next.js application built around the flow:

> signal -> entity -> relation -> radar -> report

## Runtime map

```text
Browser
  |
  v
Next.js application and API routes (127.0.0.1)
  |-- Firebase emulators: identity, documents, workflow records, artifacts
  |-- Neo4j: graph projections and graph queries
  |-- Inngest dev server: background workflow scheduling
  |-- optional model and research providers
  `-- optional Agent package through in-tree MCP servers
```

The supported prototype runs these components on one trusted machine. Firebase
and Neo4j are separate authorities with explicit reconciliation code; they are
not one transaction or backup domain.

## Product layers

### Signals and entities

Signals capture candidate observations and sources. Operators triage them into
structured entities such as technologies, companies, use cases, strategies,
and prototypes.

### Relations and graph

AI and deterministic workflows can propose relations. A proposal preserves its
evidence and confidence for review. Approved application records are projected
to Neo4j for traversal and visualization.

### Radar and reports

Radar placement turns reviewed entities and relations into a portfolio view.
Report workflows assemble draft narratives, citations, charts, and confidence
context. A report remains a reviewable artifact until an operator explicitly
shares or exports it.

### AI and MCP

The root application provides helper tools and an authenticated MCP endpoint.
The optional `agent/` package orchestrates mission profiles through the same
domain tools. Provider credentials stay in the operator environment; tool
permissions and budgets reduce risk but do not make model output trustworthy.

## Trust boundaries

- browser and API mutations require the application identity and authorization
  expected by the route;
- MCP keys expose only their granted tool permissions but remain sensitive;
- provider calls can leave the machine and incur cost;
- local emulators and databases are not hardened multi-tenant services;
- generated evidence, confidence, and reports require human verification;
- the default-off build sandbox is outside the qualified v0.1 surface.

See [Security](../SECURITY.md), [Environment](ENVIRONMENT.md), and
[Limitations](LIMITATIONS.md) for operating constraints.
