# v0.1 Limitations

Radarist `0.1.0` is a local-first prototype for evaluating the workflow:

> signal -> entity -> relation -> radar -> report

It is not a hosted service, production deployment template, compliance
certification, or autonomous decision system.

## Supported boundary

- one trusted operator on one machine;
- loopback-bound application and local services;
- seeded or non-sensitive evaluation data;
- explicit human review of AI-generated claims, relations, placements, and
  reports;
- best-effort issue support with no SLA.

## Security and deployment

The local Firebase rules, emulator identity, API surface, Neo4j service, and
process supervision are not qualified for an untrusted network or multi-tenant
deployment. Do not expose the app through a public bind, tunnel, reverse proxy,
or cloud deployment without an independent security review and substantial
hardening.

Local MCP keys and internal service keys are still credentials. A leaked key
can expose reachable data, mutate records, invoke tools, or consume provider
quota. Use only test data and rotate any value that leaves your machine.

## AI output and provider behavior

- model output can be false, incomplete, stale, biased, or unsupported;
- confidence values are workflow heuristics, not calibrated probabilities;
- citations and evidence references make a claim inspectable, not correct;
- upstream models, prices, quotas, and availability can change;
- provider calls can transmit prompts and source content and incur charges;
- recurring automation and provider-backed features require explicit opt-in.

Do not use Radarist output as the sole basis for decisions about people,
employment, credit, insurance, safety, legal rights, or other consequential
matters.

## Experimental build missions

Build missions, Limitless mode, hands-on technology evaluation, and their
sandbox are **experimental, default-off, and not qualified or supported in
v0.1**. The sandbox image and executable tool bundle are not fully pinned; when
enabled, they can resolve mutable external packages outside the qualified root
and Agent lockfiles. Reproducible sandbox pinning is deferred until after v0.1.

## Data and recovery

Firebase and Neo4j persist separately. Their snapshots are not atomic, local
checkpointing is not high availability, and a profile stored on one disk is not
a disaster-recovery backup. Keep independent copies of important source
material and exported artifacts. Use the guarded launcher/reset commands
instead of deleting containers, volumes, or emulator directories manually.

## Platform and workflow limits

- Docker and Java are required for the complete demo and emulator gates;
- WSL2 is the recommended Windows path;
- some graph, browser, and provider checks are slower than ordinary unit tests;
- empty-state and error handling are covered, but the prototype is not tested
  against every browser, operating system, or hardware profile;
- generated catalogs describe source-visible capability, not a guarantee that
  every optional integration is configured or available.

## Project model

GitHub Issues are the sole inbound channel. There is no pull-request,
contributor, support, or roadmap commitment for v0.1. See
[Support](../SUPPORT.md), [Security](../SECURITY.md), and
[Roadmap](../ROADMAP.md).
