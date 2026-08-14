/**
 * @jest-environment node
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse } from 'yaml';
import {
  DEMO_PROFILES,
  buildDemoAppLaunchPlan,
  buildInngestLaunchPlan,
  hasExpectedDockerLoopbackBindings,
} from '../lib/local-demo';
import {
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
} from '../lib/local-runtime-profile';

interface ComposeService {
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  ports?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string; labels?: Record<string, string> }>;
}

function readCompose(fileName: string): ComposeFile {
  return parse(readFileSync(resolve(process.cwd(), fileName), 'utf8')) as ComposeFile;
}

describe('local network boundary', () => {
  it('publishes every local Compose port on IPv4 loopback only', () => {
    const compose = readCompose('docker-compose.yml');

    expect(compose.services.app.ports).toEqual(['127.0.0.1:9002:9002']);
    expect(compose.services.neo4j.ports).toEqual([
      '127.0.0.1:7474:7474',
      '127.0.0.1:7687:7687',
    ]);
    expect(compose.services.inngest.ports).toEqual(['127.0.0.1:8288:8288']);
    expect(compose.services['firebase-emulator'].ports).toEqual([
      '127.0.0.1:4000:4000',
      '127.0.0.1:8080:8080',
      '127.0.0.1:9099:9099',
      '127.0.0.1:9199:9199',
    ]);
  });

  it('keeps Compose service-to-service routing on the isolated bridge network', () => {
    const compose = readCompose('docker-compose.yml');

    expect(compose.services.app.environment).toMatchObject({
      HOSTNAME: '0.0.0.0',
      NEO4J_URI: 'bolt://neo4j:7687',
      INNGEST_DEV_SERVER_URL: 'http://inngest:8288',
    });
    expect(compose.services.inngest.environment).toMatchObject({
      INNGEST_EVENT_API_URL: 'http://app:9002/api/inngest',
    });
  });

  it('publishes the supported standalone Neo4j Compose ports on loopback only', () => {
    const compose = readCompose('docker-compose.neo4j.yml');

    expect(compose.services.neo4j.ports).toEqual([
      '127.0.0.1:7474:7474',
      '127.0.0.1:7687:7687',
    ]);
    expect(compose.services.neo4j.labels).toEqual({
      'com.radarist.local-runtime': 'durable:default',
    });
    for (const name of ['neo4j_data', 'neo4j_logs', 'neo4j_import', 'neo4j_plugins']) {
      expect(compose.volumes?.[name]?.labels).toEqual({
        'com.radarist.local-runtime': 'durable:default',
      });
    }
  });

  it('pins supported host-run local entry points to loopback', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const demoFull = readFileSync(resolve(process.cwd(), 'scripts/demo-full.ts'), 'utf8');
    const nextConfig = readFileSync(resolve(process.cwd(), 'next.config.ts'), 'utf8');
    const graphOperational = readFileSync(
      resolve(process.cwd(), 'scripts/testing/run-graph-operational-gates.ts'),
      'utf8'
    );
    const firebaseConfig = JSON.parse(
      readFileSync(resolve(process.cwd(), 'firebase.json'), 'utf8')
    ) as { emulators: Record<string, { host?: string }> };

    for (const scriptName of ['dev', 'dev:emulator', 'start', 'demo:inner', 'e2e:serve']) {
      expect(packageJson.scripts[scriptName]).toMatch(/next (?:dev|start).*\s-H 127\.0\.0\.1(?:\s|$)/);
    }
    expect(packageJson.scripts['inngest:dev']).toContain('--host 127.0.0.1');
    expect(demoFull).toContain('`127.0.0.1:${profile.neo4j.http}:7474`');
    expect(demoFull).toContain('`127.0.0.1:${profile.neo4j.bolt}:7687`');
    expect(buildDemoAppLaunchPlan(DEMO_PROFILES.default, false).args).toEqual([
      'next',
      'start',
      '-H',
      '127.0.0.1',
      '-p',
      '9002',
    ]);
    expect(demoFull).toContain("runtimeEnv.RADARIST_LOCAL_PRODUCTION_BUILD = 'true'");
    expect(nextConfig).toMatch(
      /process\.env\.RADARIST_LOCAL_PRODUCTION_BUILD === 'true'/
    );
    expect(buildDemoAppLaunchPlan(DEMO_PROFILES.default, true).args).toEqual([
      'next',
      'dev',
      '--turbopack',
      '-H',
      '127.0.0.1',
      '-p',
      '9002',
    ]);
    // Assert the built plan rather than the launcher's source text: it is the
    // same value the child process actually receives, so the check cannot drift
    // from what runs.
    const inngestDataRoot = mkdtempSync(join(tmpdir(), 'network-boundary-'));
    try {
      const inngestPlan = buildInngestLaunchPlan(
        DEMO_PROFILES.default,
        ensurePrivateLocalRuntimeLayout(
          deriveLocalRuntimePaths(process.cwd(), 'default', inngestDataRoot)
        )
      );
      expect(inngestPlan.command).toBe('inngest');
      expect(inngestPlan.args.slice(0, 5)).toEqual([
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(DEMO_PROFILES.default.inngestPort),
      ]);
      expect(inngestPlan.args).toContain(
        `http://127.0.0.1:${DEMO_PROFILES.default.appPort}/api/inngest`
      );
    } finally {
      rmSync(inngestDataRoot, { recursive: true, force: true });
    }
    expect(demoFull).not.toContain('inngest-cli@');
    expect(graphOperational).toMatch(
      /\['next', 'dev', '--turbopack', '-H', '127\.0\.0\.1', '-p'/
    );
    expect(graphOperational).toMatch(
      /'inngest-cli@1\.36\.0',[\s\S]*?'dev',[\s\S]*?'--host',[\s\S]*?'127\.0\.0\.1'/
    );
    for (const emulator of ['auth', 'firestore', 'storage', 'ui']) {
      expect(firebaseConfig.emulators[emulator].host).toBe('127.0.0.1');
    }
  });

  it('rejects stale or incomplete Docker port mappings before demo reuse', () => {
    const expected = [
      { containerPort: 7474, hostPort: 7474 },
      { containerPort: 7687, hostPort: 7687 },
    ];
    const safe = JSON.stringify({
      '7474/tcp': [{ HostIp: '127.0.0.1', HostPort: '7474' }],
      '7687/tcp': [{ HostIp: '127.0.0.1', HostPort: '7687' }],
    });
    const wildcard = JSON.stringify({
      '7474/tcp': [{ HostIp: '0.0.0.0', HostPort: '7474' }],
      '7687/tcp': [{ HostIp: '0.0.0.0', HostPort: '7687' }],
    });
    const extraPort = JSON.stringify({
      ...JSON.parse(safe),
      '6362/tcp': [{ HostIp: '127.0.0.1', HostPort: '6362' }],
    });
    const duplicateBinding = JSON.stringify({
      '7474/tcp': [
        { HostIp: '127.0.0.1', HostPort: '7474' },
        { HostIp: '127.0.0.1', HostPort: '7474' },
      ],
      '7687/tcp': [{ HostIp: '127.0.0.1', HostPort: '7687' }],
    });

    expect(hasExpectedDockerLoopbackBindings(safe, expected)).toBe(true);
    expect(hasExpectedDockerLoopbackBindings(wildcard, expected)).toBe(false);
    expect(hasExpectedDockerLoopbackBindings(extraPort, expected)).toBe(false);
    expect(hasExpectedDockerLoopbackBindings(duplicateBinding, expected)).toBe(false);
    expect(hasExpectedDockerLoopbackBindings('{"7474/tcp":[]}', expected)).toBe(false);
    expect(hasExpectedDockerLoopbackBindings('not-json', expected)).toBe(false);
    expect(hasExpectedDockerLoopbackBindings('{}', [])).toBe(false);
  });
});
