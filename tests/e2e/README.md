# E2E Test Suite

## Quick Start

### Local Development

1. Audit ownership: `npm run e2e:contracts`
2. Run the self-contained generic lane: `npm run e2e`
3. Run the release smoke subset: `npm run e2e:smoke`
4. To inspect an already-running local stack without owning it: `npm run e2e:local`

### CI

- Firebase Auth, Firestore, and Storage emulators start automatically.
- The canonical showcase and its pinned owner account are seeded before the browser starts.
- No secrets required for auth (emulator uses fake API keys)
- Generic Playwright forces graph and Inngest off, blanks every recognized
  provider credential, and blocks external browser requests. Local environment
  files cannot reconnect it to retained services or paid providers.

## Runtime Ownership (TEST-023)

[`runtime-manifest.json`](./runtime-manifest.json) is the executable source of
truth for browser-spec ownership. Every `*.spec.ts` / `*.test.ts` under this
directory is assigned explicitly to exactly one primary lane. There is no
implicit generic fallback and no quarantine lane. `npm run e2e:contracts`
rejects duplicate or missing assignments, missing commands/configs, invalid
retirement evidence, and growth in soft-pass, fixed-wait, or static Playwright
discovery-count debt. Discovery checks use `--list` and start no services.

`npm run e2e:partition-proof` is the owned exact-SHA launcher. It requires a
clean tree, blanks provider credentials, runs every active lane serially,
captures raw Playwright JSON plus runner logs, compares independent listener
and Docker snapshots, and evaluates the exact discovered/executed test-ID
union. Manual lanes are recorded as not run. The command remains intentionally
red while generic assertion-integrity debt or any active lane is non-green;
partition completeness and assertion integrity are reported separately.
The launcher itself now provisions the graph that `caller-owned-disposable`
lanes (`demo`, `relation-workflow-integrity`) declare: a labelled, self-removing
`neo4j:5.15.0-community` container with a `/data` tmpfs, loopback-only Bolt on
`17692`, proven empty before the lane starts and removed inside the same residue
window (`scripts/lib/disposable-neo4j-runtime.ts`). Browser acceptance uses
`17692` rather than the repository-wide disposable integration port `17687`
because `17687` is also the Bolt port of the canonical `selftest` local-runtime
profile — a demo journey pointed there while a retained selftest stack is up
seeds and then deletes its graph fixture inside retained data, and the
loopback/not-`7687` disposability guard cannot tell the two apart. Inherited
`NEO4J_*` values are blanked for every other lane. A lane may only opt out of
the receipt by declaring a runtime the launcher cannot provision; that rule is
enforced by `unprovisionableRuntimeDependencies` in the manifest audit.

| Lane                                | Command                                              | Owned runtime                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic                             | `npm run e2e`                                        | disposable Auth/Firestore/Storage + showcase; graph/Inngest/providers disabled; external browser requests blocked                                  |
| Graph + Inngest                     | `npm run e2e:graph-inngest`                          | 20 tests on a shifted, disposable Firebase/Neo4j/Inngest stack; no skips, flakes, failures, or provider keys                                       |
| Run outage                          | `npm run e2e:run-artifact-trust`                     | empty dedicated Auth/Firestore namespace; graph/Inngest/providers disabled                                                                         |
| Relation authority + research-first | `npm run test:acceptance:relation-authority-visible` | disposable Firebase/Neo4j/Inngest + loopback Gemini stub                                                                                           |
| Local smoke                         | `npm run e2e:local`                                  | caller-owned local server; the three readiness probes do not invoke AI, so provider state is operator-selected rather than controlled by this lane |
| Live provider                       | `npm run e2e:flaky`                                  | manual, explicitly credentialed; never part of generic or CI smoke                                                                                 |
| Phase 4 session                     | `npm run e2e:phase4-session`                         | caller-owned app/Firebase stack plus explicitly disposable Neo4j on `127.0.0.1:17687`; caller tears down the entire disposable runtime             |

Other specialized lanes, their exact configs, and retired-spec evidence are
listed in the manifest. Do not add filename globs to
`playwright.config.ts`; assign a spec to its runtime contract instead.

The legacy `phase4-session-tracking.spec.ts` directly mutates Neo4j and has its
own exact manual config. Its file-level guard requires an explicit disposable
graph on `127.0.0.1:17687`; the command starts no services, so the caller owns
and tears down the matching app, Firebase stack, and disposable graph. The
retired Relations Manager/Link Mode
spec was removed with its already-deleted product island instead of preserving
a permanently skipped test.

### Curated Release Journey

Run `npm run e2e:demo` with exclusive access to a caller-owned disposable Neo4j
clone on port `17692` (`npm run e2e:partition-proof` provisions one; a manual
operator run must supply it). The command owns and cleans Auth, Firestore, and Storage
emulators, seeds the curated Firestore demo without broad graph mirroring, and
seeds then cleans only its exact graph CI fixture; it does not create or remove
the Neo4j server or volume. It disables Inngest schedules and
navigates dashboard, library, radar, triage, agent runs, reports, Settings
save/reload/restore, and the bounded non-vacuous graph view. Normal navigation
can record session/view telemetry, so both disposable confirmations are
mandatory; the lane rejects external browser requests and the default Neo4j
port. A hard-killed run is recovered by the next fixture seed's pre-clean step.

### Accessibility Release Sweep

Run `npm run e2e:accessibility`. The command owns disposable Auth, Firestore,
and Storage emulators, seeds the canonical demo in Firestore-only mode, and
starts the app with `RADARIST_GRAPH_RUNTIME_MODE=disabled` plus an empty
`NEO4J_URI`. The spec is excluded from generic Playwright runs unless its exact
disposable guard is present.

The sweep covers app-owned dialog descriptions and compact-control names across
triage, Settings, entity sheets, relationship maps, Documents, and radar
deletion. It creates one UUID-suffixed radar solely to make the real delete
AlertDialog reachable, cancels deletion, verifies the record remains, and then
removes only that exact fixture. Page exceptions, same-origin HTTP 5xx
responses, and Radix accessibility warnings fail the acceptance. The spec
contains no conditional skips or fixture-dependent early returns; its list
contract is also checked during release review.

The runtime guard also recognizes one exact selftest tuple: project
`demo-radarist-selftest`, Firebase ports `18080/19099/19199`, and the same
disposable graph on Bolt `17692`. This is an operator fallback, not a one-flag
command: `E2E_DEMO_RUNTIME_PROFILE=selftest` selects the guard profile but does
not start those emulators, change Playwright's port `9002`, or inject the
matching public/server Firebase variables. Prestart an app build with the full
tuple, export the corresponding `NEXT_PUBLIC_*` and server emulator hosts, and
set `E2E_REUSE_EXISTING_SERVER=true`. The canonical owned lane remains
`npm run e2e:demo`; arbitrary projects, hosts, and ports are rejected.

## Auth Setup

The `auth.setup.ts` file handles authentication:

1. Creates a test user in the Firebase Auth Emulator via REST API.
2. Each test page signs in through the emulator-only browser helper.
3. The fixture attests the browser project and Auth emulator origin before it submits credentials.
4. All browser projects depend on the user-creation setup project.

**Important:** Every test navigating to a protected route must call `assertAuthenticated(page)` to verify it's not on the login page.

## Environment Variables

| Variable                            | Local Default                        | CI                                                                |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` | `true`                               | `true`                                                            |
| `FIREBASE_AUTH_EMULATOR_HOST`       | `127.0.0.1:9099`                     | `127.0.0.1:9099`                                                  |
| `FIRESTORE_EMULATOR_HOST`           | `127.0.0.1:8080`                     | `127.0.0.1:8080`                                                  |
| `E2E_USER_EMAIL`                    | `e2e-test@radarist.local`            | (auto-created)                                                    |
| `E2E_USER_PASSWORD`                 | `e2e-test-password-123`              | (auto-created)                                                    |
| `RADARIST_GRAPH_RUNTIME_MODE`       | `disabled` for generic browser lanes | `disabled` unless a guarded graph lane explicitly owns its target |

## Test Utilities

| File                           | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `auth.setup.ts`                | Auth setup (runs before all test projects)            |
| `utils/auth-guard.ts`          | `assertAuthenticated()` and `navigateAuthenticated()` |
| `utils/selectors.ts`           | Shared `data-testid` selector contracts               |
| `utils/test-data.ts`           | UI-based deterministic entity seeding                 |
| `utils/entity-test-helpers.ts` | Entity CRUD helpers (9 entity types)                  |
| `utils/actions.ts`             | Common UI action helpers                              |

## Test Files

Use `runtime-manifest.json` rather than filename conventions to determine
whether a spec is active or manual. Removed tests and their replacement or
invalid-claim rationale live in `retiredSpecs`. Tests in `deferred/` remain
excluded from every Playwright configuration.

## Writing Tests

### Auth Guard Pattern

```typescript
import { assertAuthenticated } from './utils/auth-guard';

test('should do something', async ({ page }) => {
  await page.goto('/library/companies');
  await page.waitForLoadState('networkidle');
  await assertAuthenticated(page); // REQUIRED for protected routes

  // ... test logic
});
```

### Selector Pattern

```typescript
import { SELECTORS } from './utils/selectors';

// Use data-testid selectors for stability
await page.locator(SELECTORS.emptyState).isVisible();
await page.locator(SELECTORS.createButton('company')).click();
```

### Entity Seeding

```typescript
import { seedEntity } from './utils/test-data';

test('should work with seeded data', async ({ page }) => {
  const entity = await seedEntity(page, 'technologies', {
    name: 'My Test Tech',
  });
  // entity.name, entity.type, entity.seeded
});
```

### Best Practices

- Use `assertAuthenticated(page)` after navigating to any protected route
- Synchronize on visible/loaded UI state; avoid fixed sleeps and do not assume
  `networkidle` will settle while emulator listeners are active
- Use role-based selectors: `page.getByRole('button', { name: /add/i })`
- Use `data-testid` selectors from `utils/selectors.ts` for stability
- Seed required fixtures and assert non-vacuous rows/actions; do not silently
  swallow a missing element when it is part of the behavior under test
- Keep debounce waits to 200-300ms max

## Debugging

1. **Debug mode:** `npx playwright test --debug`
2. **Headed:** `npx playwright test --headed`
3. **Screenshots:** Failed tests capture screenshots in `test-results/`
4. **Traces:** `npx playwright show-trace test-results/.../trace.zip`
5. **Inspector:** Add `await page.pause();` in test code

---

**Last Updated:** 2026-07-20
