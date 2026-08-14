/**
 * LOCAL-013 regressions for the local Inngest queue's persistence contract.
 *
 * The defect these guard: the supported launcher ran `inngest dev` with no
 * persistence flag, and the dev server defaults to `--persist=false` — the
 * entire queue lives in memory, so every restart and every forced interruption
 * silently discarded queued events, in-flight functions, and pending retries.
 *
 * Persistence is CWD-relative (`<cwd>/.inngest/`), not `$HOME`-relative, so the
 * working directory is the whole profile-privacy mechanism and is asserted here
 * rather than assumed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { DEMO_PROFILES, buildInngestLaunchPlan } from '../lib/local-demo';
import {
  LOCAL_RUNTIME_INNGEST_IMAGE,
  LOCAL_RUNTIME_INNGEST_VERSION,
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
  type LocalRuntimePaths,
} from '../lib/local-runtime-profile';

const REPOSITORY_ROOT = resolve(__dirname, '..', '..');

describe('local Inngest queue durability (LOCAL-013)', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'local-013-'));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function paths(profileName: 'default' | 'selftest' = 'default'): LocalRuntimePaths {
    return ensurePrivateLocalRuntimeLayout(
      deriveLocalRuntimePaths(REPOSITORY_ROOT, profileName, dataRoot)
    );
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  it('starts the dev server with persistence enabled', () => {
    const plan = buildInngestLaunchPlan(DEMO_PROFILES.default, paths());

    // Without this flag the queue is in-memory and a restart loses everything.
    expect(plan.args).toContain('--persist');
  });

  it('binds the dev server to loopback on the profile port', () => {
    const profile = DEMO_PROFILES.selftest;

    const plan = buildInngestLaunchPlan(profile, paths('selftest'));

    expect(plan.command).toBe('inngest');
    expect(plan.args.slice(0, 6)).toEqual([
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(profile.inngestPort),
      '-u',
    ]);
  });

  // ==========================================================================
  // Profile privacy
  // ==========================================================================

  it('keeps the persisted queue inside the profile-private layout', () => {
    const runtimePaths = paths();

    const plan = buildInngestLaunchPlan(DEMO_PROFILES.default, runtimePaths);

    expect(plan.cwd).toBe(runtimePaths.inngestState);
    expect(plan.statePath).toBe(join(runtimePaths.inngestState, '.inngest'));
    expect(plan.statePath.startsWith(runtimePaths.root)).toBe(true);
  });

  it('gives each profile a queue no other profile can reach', () => {
    const defaultPlan = buildInngestLaunchPlan(DEMO_PROFILES.default, paths());
    const selftestPlan = buildInngestLaunchPlan(DEMO_PROFILES.selftest, paths('selftest'));

    expect(defaultPlan.statePath).not.toBe(selftestPlan.statePath);
    expect(defaultPlan.statePath.startsWith(selftestPlan.cwd)).toBe(false);
    expect(selftestPlan.statePath.startsWith(defaultPlan.cwd)).toBe(false);
  });

  it('does not place queue state in the shared working directory', () => {
    const runtimePaths = paths();

    const plan = buildInngestLaunchPlan(DEMO_PROFILES.default, runtimePaths);

    expect(plan.cwd).not.toBe(runtimePaths.workingDirectory);
  });

  it('refuses a state directory that escapes the profile root via a symlink', () => {
    const runtimePaths = paths();
    const escaped = { ...runtimePaths, inngestState: resolve(dataRoot, '..', 'outside') };

    expect(() => buildInngestLaunchPlan(DEMO_PROFILES.default, escaped)).toThrow();
  });

  // ==========================================================================
  // Carry-over detection — the signal recovery is gated on
  // ==========================================================================

  it('reports a fresh queue when no prior state exists', () => {
    const plan = buildInngestLaunchPlan(DEMO_PROFILES.default, paths());

    expect(existsSync(plan.statePath)).toBe(false);
    expect(plan.queueStateCarriedOver).toBe(false);
  });

  it('reports carried-over state when a previous runtime left a queue behind', () => {
    const runtimePaths = paths();
    mkdirSync(join(runtimePaths.inngestState, '.inngest'), { recursive: true });

    const plan = buildInngestLaunchPlan(DEMO_PROFILES.default, runtimePaths);

    // This is what stops recovery from terminalizing work that will resume.
    expect(plan.queueStateCarriedOver).toBe(true);
  });

  // ==========================================================================
  // Version pinning
  // ==========================================================================

  describe('version pinning', () => {
    it('pins the Compose image to the CLI version the launcher runs', () => {
      const compose = readFileSync(join(REPOSITORY_ROOT, 'docker-compose.yml'), 'utf-8');

      expect(compose).toContain(`image: ${LOCAL_RUNTIME_INNGEST_IMAGE}`);
      // `:latest` can change the on-disk queue format between restarts and
      // strand the state the mounted volume exists to preserve.
      expect(compose).not.toContain('inngest/inngest:latest');
    });

    it('runs the Compose dev server with the same persistence contract', () => {
      const compose = readFileSync(join(REPOSITORY_ROOT, 'docker-compose.yml'), 'utf-8');

      expect(compose).toContain('--persist');
      expect(compose).toContain('inngest-state:/state');
    });

    it('keeps the pinned version in step with the installed CLI', () => {
      const packageJson = JSON.parse(
        readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf-8')
      ) as { devDependencies: Record<string, string> };

      expect(packageJson.devDependencies['inngest-cli']).toBe(LOCAL_RUNTIME_INNGEST_VERSION);
    });
  });
});
