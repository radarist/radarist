/** @jest-environment node */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const demoFull = readFileSync(resolve(process.cwd(), 'scripts/demo-full.ts'), 'utf8');
const E2E_BUILD_ENV = 'E2E_BUILD';
const LOCAL_PRODUCTION_BUILD_ENV = 'RADARIST_LOCAL_PRODUCTION_BUILD';

describe('demo:full startup control', () => {
  const originalE2eBuild = process.env[E2E_BUILD_ENV];
  const originalLocalProductionBuild = process.env[LOCAL_PRODUCTION_BUILD_ENV];

  afterEach(() => {
    if (originalE2eBuild === undefined) delete process.env[E2E_BUILD_ENV];
    else process.env[E2E_BUILD_ENV] = originalE2eBuild;
    if (originalLocalProductionBuild === undefined) {
      delete process.env[LOCAL_PRODUCTION_BUILD_ENV];
    } else {
      process.env[LOCAL_PRODUCTION_BUILD_ENV] = originalLocalProductionBuild;
    }
    jest.resetModules();
  });

  function nextOutput(
    e2eBuild: string | undefined,
    localProductionBuild: string | undefined
  ): unknown {
    if (e2eBuild === undefined) delete process.env[E2E_BUILD_ENV];
    else process.env[E2E_BUILD_ENV] = e2eBuild;
    if (localProductionBuild === undefined) {
      delete process.env[LOCAL_PRODUCTION_BUILD_ENV];
    } else {
      process.env[LOCAL_PRODUCTION_BUILD_ENV] = localProductionBuild;
    }
    jest.resetModules();
    let output: unknown;
    jest.isolateModules(() => {
      output = (require('../../next.config').default as { output?: unknown }).output;
    });
    return output;
  }

  it('uses one normal production-build flag before both build and next start', () => {
    const flag = demoFull.indexOf(
      "runtimeEnv.RADARIST_LOCAL_PRODUCTION_BUILD = 'true'"
    );
    const build = demoFull.indexOf("await runCommand('npm', ['run', 'build']");
    const launch = demoFull.indexOf('const appLaunch = buildDemoAppLaunchPlan');

    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(build);
    expect(build).toBeLessThan(launch);
  });

  it('selects normal Next output only for the build modes that use next start', () => {
    expect(nextOutput(undefined, 'true')).toBeUndefined();
    expect(nextOutput('true', undefined)).toBeUndefined();
    expect(nextOutput(undefined, undefined)).toBe('standalone');
  });

  it('propagates the initial graph audit but keeps periodic audits degrade-only', () => {
    expect(demoFull).toContain("failureMode: 'propagate' | 'degrade'");
    expect(demoFull).toContain("if (failureMode === 'propagate') throw error");
    expect(demoFull).toContain(
      "await requireInitialGraphAudit(() =>\n    runGraphConsistencyAudit(runtimeEnv, 'propagate')"
    );
    expect(demoFull).toContain(
      "timeoutMs: failureMode === 'propagate' ? 30_000 : 2 * 60_000"
    );
    expect(demoFull).toContain("() => void runGraphConsistencyAudit(runtimeEnv, 'degrade')");
  });

  it('proves configured and live GDS before starting dependent services', () => {
    expect(demoFull).toContain(
      'const validation = validateNeo4jDockerPluginEnv(inspectedEnvironment)'
    );
    expect(demoFull).toContain(
      '!hasExactNeo4jDockerAuth(inspectedEnvironment, env.NEO4J_PASSWORD)'
    );
    const liveProbe = demoFull.indexOf('await waitForNeo4jGdsReadiness(runtimeEnv');
    const dataOpen = demoFull.indexOf(
      'const graphUserNodeCount = await countNeo4jUserDataNodes(runtimeEnv)'
    );
    const finalizeMigration = demoFull.indexOf(
      'finalizePendingLegacyMigration();',
      dataOpen
    );
    const schemaInitialization = demoFull.indexOf(
      "['tsx', 'scripts/init-neo4j-schema.ts']"
    );
    const firebaseStart = demoFull.indexOf(
      "firebaseChild = startChild(\n    'Firebase emulators'"
    );
    const nextStart = demoFull.indexOf("const nextChild = startChild(\n    'Next.js'");
    const inngestStart = demoFull.indexOf(
      "const inngestChild = startChild(\n      'Inngest dev server'"
    );

    expect(liveProbe).toBeGreaterThan(-1);
    expect(liveProbe).toBeLessThan(dataOpen);
    expect(dataOpen).toBeLessThan(finalizeMigration);
    expect(finalizeMigration).toBeLessThan(schemaInitialization);
    expect(schemaInitialization).toBeLessThan(firebaseStart);
    expect(firebaseStart).toBeLessThan(nextStart);
    expect(nextStart).toBeLessThan(inngestStart);
    expect(demoFull).toContain(
      'if (gdsVersion !== PINNED_NEO4J_GDS_VERSION)'
    );
  });

  it('provisions the checksum-pinned GDS artifact before creating Neo4j', () => {
    const durableStart = demoFull.indexOf('function startNeo4j(');
    const provisioning = demoFull.indexOf(
      'provisionPinnedGdsArtifact(pluginVolume, env);',
      durableStart
    );
    const durableCreate = demoFull.indexOf(
      'console.log(`[demo:full] Creating Neo4j container ${profile.neo4jContainer}`)'
    );

    expect(provisioning).toBeGreaterThan(-1);
    expect(provisioning).toBeLessThan(durableCreate);
    expect(demoFull).toContain(
      'buildPinnedGdsArtifactProbeArgs(pluginVolume)'
    );
    expect(demoFull).toContain(
      'assertSupportedPinnedGdsCurl(curlCommand, curlEnvironment)'
    );
    expect(demoFull).toContain(
      'downloadPinnedGdsArtifact(\n      curlCommand,\n      artifactPath,\n      curlEnvironment,\n      130_000'
    );
    expect(demoFull).toContain(
      'buildPinnedGdsArtifactImportArgs(pluginVolume, artifactPath)'
    );
    expect(demoFull).toContain('assertPinnedGdsHostArtifact(artifactPath)');
    expect(demoFull).toContain("rmSync(stagingDirectory, { recursive: true, force: true })");
    expect(demoFull).toContain("'NEO4J_PLUGINS=[\"apoc\"]'");
    expect(demoFull).not.toContain(
      "'NEO4J_PLUGINS=[\"apoc\",\"graph-data-science\"]'"
    );
  });

  it('migrates legacy mutable plugin intent behind a retained-container rollback boundary', () => {
    const migration = demoFull.indexOf(
      'function migrateLegacyDurableNeo4jContainer('
    );
    const provision = demoFull.indexOf(
      'provisionPinnedGdsArtifact(pluginVolume, env);',
      migration
    );
    const renameOriginal = demoFull.indexOf(
      "runSync('docker', ['rename', profile.neo4jContainer, backupContainer], env);",
      migration
    );
    const createReplacement = demoFull.indexOf(
      'runSync(\'docker\', buildDurableNeo4jCreateArgs(profile, env), env);',
      migration
    );
    const checksum = demoFull.indexOf(
      '!hasPinnedGdsArtifactInRunningContainer(profile.neo4jContainer)',
      migration
    );
    const stageMessage = demoFull.indexOf(
      'retaining the stopped migration backup until live runtime verification',
      migration
    );
    const rollbackOriginal = demoFull.indexOf(
      "runSync('docker', ['rename', backupContainer, profile.neo4jContainer], env);",
      demoFull.indexOf('function rollbackPendingLegacyMigration()')
    );
    const finalize = demoFull.indexOf('function finalizePendingLegacyMigration()');
    const removeBackup = demoFull.indexOf(
      "runSync('docker', ['rm', backupContainer], env);",
      finalize
    );

    expect(migration).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(migration);
    expect(provision).toBeLessThan(renameOriginal);
    expect(renameOriginal).toBeLessThan(createReplacement);
    expect(createReplacement).toBeLessThan(checksum);
    expect(checksum).toBeLessThan(stageMessage);
    expect(finalize).toBeGreaterThan(-1);
    expect(removeBackup).toBeGreaterThan(finalize);
    expect(rollbackOriginal).toBeGreaterThan(-1);
    expect(demoFull).toContain("if (provisioning === 'legacy-auto')");
    expect(demoFull).toContain('reconcileInterruptedLegacyMigration(profile, env)');
    expect(demoFull).toContain('finalizePendingLegacyMigration();');
    expect(demoFull).toContain(
      "'The named data volumes were not removed and the legacy container was not restarted.'"
    );
  });

  it('tracks ephemeral identities before mutation and independently cleans an auto-removed container volume', () => {
    const start = demoFull.indexOf('function startEphemeralNeo4j(');
    const trackOwner = demoFull.indexOf('ephemeralNeo4jOwner = owner;', start);
    const createVolume = demoFull.indexOf("'volume',\n      'create'", start);
    const cleanup = demoFull.indexOf('async function performCleanup()');
    const absentContainer = demoFull.indexOf(
      'if (dockerContainerExists(ephemeralNeo4jContainer))',
      cleanup
    );
    const volumeCleanup = demoFull.indexOf(
      'if (ephemeralNeo4jPluginVolume && ephemeralNeo4jOwner && ephemeralContainerStopped)',
      cleanup
    );
    const absentVolume = demoFull.indexOf(
      'if (!dockerVolumeExists(ephemeralNeo4jPluginVolume))',
      volumeCleanup
    );
    const proveContainerAbsent = demoFull.indexOf(
      'await stopAndRemoveDockerContainer(ephemeralNeo4jContainer',
      absentContainer
    );

    expect(trackOwner).toBeGreaterThan(start);
    expect(trackOwner).toBeLessThan(createVolume);
    expect(absentContainer).toBeGreaterThan(cleanup);
    expect(proveContainerAbsent).toBeGreaterThan(absentContainer);
    expect(proveContainerAbsent).toBeLessThan(volumeCleanup);
    expect(volumeCleanup).toBeGreaterThan(absentContainer);
    expect(absentVolume).toBeGreaterThan(volumeCleanup);
    expect(demoFull).toContain(
      'runtimeLabel !== ephemeralNeo4jRuntimeLabel'
    );
  });

  it('redacts synchronous command arguments from startup failures', () => {
    const runSync = demoFull.indexOf('function runSync(');
    const nextFunction = demoFull.indexOf(
      'async function assertProductPortsAvailable(',
      runSync
    );
    const implementation = demoFull.slice(runSync, nextFunction);
    expect(implementation).toContain('arguments were redacted');
    expect(implementation).not.toContain("args.join(' ')");
  });

  it('marks teardown before cleanup after a startup failure', () => {
    const failureHandler = demoFull.indexOf('main().catch(async (error) => {');
    const teardown = demoFull.indexOf('shuttingDown = true;', failureHandler);
    const cleanup = demoFull.indexOf('await cleanup();', failureHandler);

    expect(failureHandler).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(failureHandler);
    expect(teardown).toBeLessThan(cleanup);
    expect(demoFull).toContain(
      "child.once('exit', (code, signal) => {\n    if (shuttingDown) return;"
    );
    expect(demoFull).toContain(
      'const cleanup = createIdempotentAsyncAction(performCleanup);'
    );
  });
});
