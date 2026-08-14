# Radarist Agent Runtime

The `agent/` package contains the optional Anthropic Claude Agent SDK runtime
used by Radarist research missions. It loads specialized profiles, connects
them to the in-tree MCP surface, applies permission and budget hooks, and
returns artifacts to the main application through Inngest.

This package is separate from the Gemini-based helper layer in the root app.
Installing or running it requires accepting the provider's terms, supplying
your own credentials, and accepting provider charges.

## v0.1 support boundary

Research-mission orchestration is prototype functionality and requires human
review of every output.

Build missions and their sandbox are **experimental, default-off, and not a
qualified or supported v0.1 feature**. When enabled, the sandbox can resolve
mutable external executables outside the qualified root and Agent lockfiles.
Pinning that image and executable bundle is deferred until after v0.1. Do not
use build missions for sensitive or reproducible work.

## Package layout

```text
agent/
├── agents/             mission profile definitions
├── runtime-plugin/     runtime skills
├── src/                orchestration, policy, hooks, and sandbox code
└── tests/              deterministic package tests
```

## Local package checks

From the repository root:

```bash
npm ci --prefix agent
npm run lint --prefix agent
npm run typecheck --prefix agent
npm test --prefix agent
npm run build --prefix agent
npm audit --prefix agent --audit-level=critical
```

`npm run setup:agents` installs the locked package and builds it for the main
application. Provider-backed execution remains opt-in.

For the surrounding application boundary, read
[Architecture](../docs/HIGH_LEVEL_ARCHITECTURE.md),
[Environment](../docs/ENVIRONMENT.md), and
[Limitations](../docs/LIMITATIONS.md).
