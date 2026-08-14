# Environment

Radarist `0.1.0` uses reviewed environment templates and loopback-bound local
services. Configuration is operator-owned; credentials must remain untracked.

## Templates

| File | Purpose |
| --- | --- |
| `.env.example.minimal` | Small seeded-demo starting point with safe local defaults. |
| `.env.example` | Full public settings reference for retained runtime paths. |
| `.env.docker.example` | Explicit values needed by the experimental Compose path. |

The normal setup command creates `.env.local`:

```bash
npm run setup:local
npm run doctor
```

Do not copy real values into a tracked template. Do not commit `.env.local`,
`.env.docker`, `impulse.config.yaml`, `.mcp.json`, or provider credentials.

## Local services

The supported demo launcher owns a profile-specific local runtime and publishes
services on loopback only.

| Service | Role |
| --- | --- |
| Next.js | application and API routes |
| Firebase emulators | Auth, Firestore, and Storage |
| Neo4j Community | graph projections and queries |
| Inngest dev server | background workflow scheduling |

Exact ports can vary for named profiles. Use the URLs printed by
`npm run demo:full`; do not expose them through a tunnel or public bind.

## Provider settings

Provider-backed features are optional. The full template documents supported
Google/Gemini, Anthropic, OpenRouter, research, model-selection, budget, and
timeout settings. Configure the smallest set required for the feature under
test.

- keys are read from the local process environment;
- model IDs and provider behavior can change upstream;
- provider calls may send prompt or source content outside your machine;
- usage can incur charges under your account;
- recurring automation remains paused until explicitly enabled.

The public template intentionally omits runner-owned test variables and legacy
aliases. Do not set undocumented variables copied from test code.

## Agent and sandbox boundary

The optional Agent package uses its own lockfile and provider configuration.
Build missions are experimental and default-off. Their sandbox image and
external executable bundle are not pinned or qualified for v0.1, so enabling
that path is outside the supported environment contract.

## Reset and persistence

The default `demo:full` durability is persistent. The mode flag controls the
initial seed, while the profile controls which saved workspace is restored.

| Local state | Persistent showcase/blank | Disposable (`--ephemeral`) |
| --- | --- | --- |
| Firebase Auth, Firestore, Storage | Verified generations under `emulator-data/<profile>/checkpoints`; latest valid generation is restored. | Session-private emulator files; no durable checkpoint is read or written. |
| Neo4j | Profile-owned Docker container and named volumes are reused. | One-run container with disposable data storage; removed during bounded cleanup. |
| Inngest | Queue state under the profile runtime directory is resumed. | Session-private queue state; removed during bounded cleanup. |
| `.env.local` | Retained local configuration. | Retained local configuration; it is not workspace data. |

Firebase and Neo4j persist independently and are not an atomic backup. The
launcher verifies Firebase checkpoints and refuses to pair a fresh Firebase
workspace with a durable graph that already contains user data.

Stop with `Ctrl+C` and wait for the shutdown acknowledgement before restarting
or resetting. Preview the default profile reset with:

```bash
npm run demo:reset -- --profile default --include-neo4j
```

Apply a normal full reset only after reviewing the preview:

```bash
npm run demo:reset -- --profile default --apply --confirm-profile default --include-neo4j
```

The full reset removes the selected profile's Firebase and Inngest workspace
plus its owned Neo4j container/volumes, while leaving `.env.local`, other
profiles, packages, and source files untouched. Keep a separate copy of
important source material, and read [Limitations](LIMITATIONS.md) before relying
on local persistence.
