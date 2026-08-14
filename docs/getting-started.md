# Getting Started

Radarist `0.1.0` is a local-first prototype. The supported evaluation path runs
the application, Firebase emulators, Inngest, and Neo4j on one trusted machine.

## Prerequisites

- Node.js `^20.19.0 || ^22.12.0 || ^24.0.0`;
- npm `11.5.1`;
- Docker;
- Java 21;
- curl `8.4.0` or newer;
- Git and a shell environment. WSL2 is the recommended Windows path.

The first install and service start require network access for locked npm
packages, emulator assets, and Docker images.

## Install

```bash
git clone https://github.com/radarist/radarist.git
cd radarist
npm ci
npm run setup:local
npm run doctor
```

`setup:local` creates the gitignored local environment file. Review it before
starting services. Never commit credentials or generated local configuration.

## Choose a workspace

The launcher supports four useful starting points. They run the same local
services and differ only in initial content and whether workspace data is kept.

| Choice | Command | First start | After `Ctrl+C` and restart |
| --- | --- | --- | --- |
| Explore the demo and keep your work | `npm run demo:full -- --showcase` | Creates the local login and curated signals, entities, relations, radar, and report examples. | Restores the latest verified Firebase checkpoint, the profile-owned Neo4j data, and the Inngest queue. |
| Start blank and keep your work | `npm run demo:full -- --blank` | Creates only the local login; no showcase entities are seeded. | Restores everything you created in the blank workspace. |
| Explore the demo without keeping data | `npm run demo:full -- --ephemeral` | Creates a one-run showcase workspace isolated from durable checkpoints and graph volumes. | Clean shutdown removes the disposable Firebase, Neo4j, and Inngest workspace. The durable profile is untouched. |
| Start blank without keeping data | `npm run demo:full -- --blank --ephemeral` | Creates a one-run empty workspace with only the local login. | Clean shutdown removes the entire disposable workspace. |

`npm run demo:full` without a mode flag is equivalent to `--showcase`. Add
`--dev` to any choice when you need Next.js development mode and hot reload;
the default runs a production build.

### Persistent-workspace rule

`--showcase` and `--blank` choose the seed only when the selected profile has no
verified Firebase checkpoint. Once a persistent workspace exists, it is
authoritative: restarting with either flag restores it and does not seed over
your data. To change from a populated workspace to a genuinely blank one, use
the guarded full reset below and then launch with `--blank`.

### Sign in

Open `http://127.0.0.1:9002`. With the generated defaults, a freshly seeded
showcase, blank, or disposable workspace creates:

```text
demo@radarist.local
radarist-demo-password
```

The launcher's printed `Login` line is authoritative. When a persistent profile
is restored, its saved Firebase Auth data is restored too; an operator-supplied
local password may also replace the generated default shown above.

The showcase works without AI provider credentials. It is the fastest way to
inspect signals, relation triage, graph views, the radar, and report drafts.

### Stop and resume

Stop the launcher with `Ctrl+C`. In persistent mode the shutdown sequence
creates a final verified Firebase checkpoint, stops the processes it owns, and
leaves the profile-owned Neo4j container available for reuse. The next launch
resumes that profile's Firebase checkpoint, Neo4j data, and Inngest queue. These
stores persist independently; they are not an atomic backup.

Disposable mode neither reads nor writes durable checkpoints. A clean shutdown
removes its one-run Firebase files, Neo4j container/storage, and Inngest queue.
Local configuration such as `.env.local`, installed packages, and Docker image
caches are not workspace data and remain on the machine.

A persistent Neo4j container remains available after `Ctrl+C`. If you want to
evaluate a disposable workspace without stopping or resetting that profile,
use a separate local profile:

```bash
npm run setup:local -- --profile selftest
npm run doctor -- --profile selftest
npm run demo:full -- --profile selftest --ephemeral
```

The launcher prints the profile-specific URLs. For the default profile they are
the app on `9002`, Firebase UI on `4000`, Neo4j Browser on `7474`, and Inngest
on `8288`.

## Reset a persistent workspace

Stop the running launcher cleanly before resetting. Preview is always the first
step and does not delete anything:

```bash
npm run demo:reset -- --profile default --include-neo4j
```

For the normal clean-slate reset, repeat the profile name exactly and include
both Firebase and Neo4j data:

```bash
npm run demo:reset -- --profile default --apply --confirm-profile default --include-neo4j
```

This removes `emulator-data/default` (including the profile's Firebase and
Inngest state) plus only the Docker container and named volumes owned by the
`default` profile. It leaves `.env.local`, other profiles, installed packages,
and source files untouched. The command refuses to run against an active or
mismatched profile.

An advanced `--firebase-only` scope exists, but it deliberately leaves the
graph behind and blocks the next durable launch until the stores are reconciled
with a guarded full reset. It is not the normal way to obtain a blank workspace.
Do not delete emulator directories or Docker volumes by hand.

## Optional provider features

Copy provider keys only into the gitignored local environment and enable only
the surface you intend to test. Provider calls can transmit prompt content and
incur charges. Background automation starts paused.

Build missions and their sandbox are experimental, default-off, and not
qualified or supported in v0.1. Leave them disabled for the supported
evaluation path.

## Troubleshooting

```bash
npm run doctor
npm run neo4j:status
npm run graph:health
```

Common causes are a missing Java runtime, Docker not running, an occupied local
port, or stale local configuration. Read [Environment](ENVIRONMENT.md),
[Limitations](LIMITATIONS.md), and [Support](../SUPPORT.md) before filing an
issue.
