/**
 * @jest-environment node
 */

import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as dotenv from 'dotenv';
import packageJson from '../../package.json';
import type { DemoProfileConfig } from '../lib/local-demo';
import {
  DEMO_PROFILES,
  DEPRECATED_INNGEST_SDK_ENV_KEYS,
  PINNED_NEO4J_GDS_MAX_DOWNLOAD_BYTES,
  PINNED_NEO4J_GDS_MIN_CURL_VERSION,
  PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE,
  MANAGED_ENV_KEYS,
  PINNED_NEO4J_GDS_SHA256,
  PINNED_NEO4J_GDS_URL,
  assertFreshFirebaseGraphCompatibility,
  buildDemoAppLaunchPlan,
  buildDemoEnv,
  buildPinnedGdsArtifactImportArgs,
  buildPinnedGdsArtifactProbeArgs,
  buildPinnedGdsDownloadArgs,
  buildPinnedGdsDownloadEnvironment,
  createIdempotentAsyncAction,
  downloadPinnedGdsArtifact,
  ensureDemoEnvFile,
  envForChild,
  formatDoctorEnvDetail,
  getProfileConfig,
  hasExactNeo4jDockerAuth,
  hasExpectedDockerNamedVolumeMounts,
  isSupportedPinnedGdsCurlVersion,
  isChildProcessRunning,
  isPlaceholder,
  isValidMcpBaseUrl,
  parseDemoDurabilityMode,
  parseCurlVersion,
  parseDemoFullOptions,
  parseDemoSeedMode,
  parseProfileArg,
  planMissingDockerVolumes,
  planLegacyGdsMigrationRecovery,
  probePinnedGdsCurlVersion,
  requireInitialGraphAudit,
  resolvePinnedGdsCurlCommand,
  resolveInngestSdkRouting,
  runCommand,
  serializeDemoEnv,
  validateNeo4jDockerPluginEnv,
  validateDemoEnv,
  waitForHttp,
} from '../lib/local-demo';

describe('runCommand', () => {
  it('treats both exit-code and signal termination as stopped', () => {
    expect(isChildProcessRunning({ exitCode: null, signalCode: null })).toBe(true);
    expect(isChildProcessRunning({ exitCode: 0, signalCode: null })).toBe(false);
    expect(isChildProcessRunning({ exitCode: null, signalCode: 'SIGTERM' })).toBe(false);
  });

  it('bounds and stops a command that outlives its timeout', async () => {
    const startedAt = Date.now();
    await expect(
      runCommand(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {}, { timeoutMs: 50 })
    ).rejects.toThrow(/exceeded its 50ms timeout/);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('rejects invalid timeout values before spawning', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.exit(0)'], {}, { timeoutMs: 0 })).rejects.toThrow(
      /positive integer/
    );
  });

  it('never reflects command arguments in a process failure', async () => {
    const secretArgument = 'neo4j/private-password';
    let observed: Error | undefined;
    try {
      await runCommand(
        process.execPath,
        ['-e', 'process.exit(7)', secretArgument],
        {}
      );
    } catch (error) {
      observed = error as Error;
    }
    expect(observed?.message).toContain('exited with code 7');
    expect(observed?.message).toContain('arguments were redacted');
    expect(observed?.message).not.toContain(secretArgument);
  });
});

describe('initial graph audit startup boundary', () => {
  it('propagates the first failure without retrying or sleeping', async () => {
    const failure = new Error('graph integrity failed');
    const audit = jest.fn().mockRejectedValue(failure);
    const startedAt = Date.now();

    await expect(requireInitialGraphAudit(audit)).rejects.toBe(failure);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});

describe('waitForHttp', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails before a network probe when the owned service has exited', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      waitForHttp('http://127.0.0.1:65534', 100, {
        attemptTimeoutMs: 10,
        pollIntervalMs: 1,
        assertWaitingStillValid: () => {
          throw new Error('owned Neo4j container exited');
        },
      })
    ).rejects.toThrow('owned Neo4j container exited');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a bounded healthy response and validates invalid budgets', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ status: 200 } as Response);
    await expect(
      waitForHttp('http://127.0.0.1:7474', 100, {
        attemptTimeoutMs: 10,
        pollIntervalMs: 1,
      })
    ).resolves.toBeUndefined();
    await expect(waitForHttp('http://127.0.0.1:7474', 0)).rejects.toThrow(
      'positive integers'
    );
  });
});

describe('createIdempotentAsyncAction', () => {
  it('shares one execution and one promise across overlapping cleanup paths', async () => {
    let resolveAction!: (value: string) => void;
    const action = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveAction = resolve;
        })
    );
    const cleanup = createIdempotentAsyncAction(action);

    const fromSignal = cleanup();
    const fromStartupFailure = cleanup();
    expect(fromStartupFailure).toBe(fromSignal);
    expect(action).toHaveBeenCalledTimes(0);

    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    resolveAction('closed');
    await expect(fromSignal).resolves.toBe('closed');
    await expect(cleanup()).resolves.toBe('closed');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('memoizes a synchronous teardown failure as one rejected promise', async () => {
    const action = jest.fn(async () => {
      throw new Error('cleanup failed');
    });
    const cleanup = createIdempotentAsyncAction(action);
    const first = cleanup();
    const second = cleanup();

    expect(second).toBe(first);
    await expect(first).rejects.toThrow('cleanup failed');
    await expect(cleanup()).rejects.toThrow('cleanup failed');
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('local demo script helpers', () => {
  const expectedMounts = [
    { name: 'radarist_neo4j_data', destination: '/data' },
    { name: 'radarist_neo4j_logs', destination: '/logs' },
    { name: 'radarist_neo4j_import', destination: '/var/lib/neo4j/import' },
    { name: 'radarist_neo4j_plugins', destination: '/plugins' },
  ];

  describe('retained Neo4j plugin contract', () => {
    it.each([
      ['canonical pinned declaration', 'NEO4J_PLUGINS=["apoc"]', 'pinned'],
      [
        'legacy semantic whitespace',
        'NEO4J_PLUGINS=[ "apoc", "graph-data-science" ]',
        'legacy-auto',
      ],
      [
        'legacy reversed order',
        'NEO4J_PLUGINS=["graph-data-science","apoc"]',
        'legacy-auto',
      ],
    ])('accepts %s', (_case, pluginEntry, provisioning) => {
      expect(
        validateNeo4jDockerPluginEnv(['PATH=/usr/bin', pluginEntry, 'NEO4J_AUTH=neo4j/test'])
      ).toMatchObject({ valid: true, provisioning });
    });

    it.each([
      ['a missing Config.Env', undefined, 'Docker Config.Env must be an array of strings'],
      ['a non-string Config.Env entry', ['NEO4J_PLUGINS=["apoc","graph-data-science"]', 7], 'array of strings'],
      ['a missing setting', ['PATH=/usr/bin'], 'NEO4J_PLUGINS is not configured'],
      [
        'duplicate settings',
        ['NEO4J_PLUGINS=["apoc","graph-data-science"]', 'NEO4J_PLUGINS=["apoc","graph-data-science"]'],
        'configured exactly once',
      ],
      ['malformed JSON', ['NEO4J_PLUGINS=[apoc]'], 'valid JSON array'],
      ['a non-array JSON value', ['NEO4J_PLUGINS="apoc"'], 'JSON array of strings'],
      ['GDS only', ['NEO4J_PLUGINS=["graph-data-science"]'], 'contain exactly apoc'],
      [
        'a substring lookalike',
        ['NEO4J_PLUGINS=["apoc","not-graph-data-science-extra"]'],
        'contain exactly apoc',
      ],
      [
        'a duplicate plugin',
        ['NEO4J_PLUGINS=["apoc","graph-data-science","graph-data-science"]'],
        'contain exactly apoc',
      ],
      [
        'an extra plugin',
        ['NEO4J_PLUGINS=["apoc","graph-data-science","other"]'],
        'contain exactly apoc',
      ],
    ])('rejects %s', (_case, env, reason) => {
      const validation = validateNeo4jDockerPluginEnv(env);
      expect(validation.valid).toBe(false);
      if (!validation.valid) expect(validation.reason).toContain(reason);
    });

    it('compares retained auth without exposing or normalizing the password', () => {
      expect(
        hasExactNeo4jDockerAuth(
          ['NEO4J_AUTH=neo4j/a/b c', 'NEO4J_PLUGINS=["apoc"]'],
          'a/b c'
        )
      ).toBe(true);
      expect(
        hasExactNeo4jDockerAuth(
          ['NEO4J_AUTH=neo4j/old-password', 'NEO4J_PLUGINS=["apoc"]'],
          'new-password'
        )
      ).toBe(false);
      expect(
        hasExactNeo4jDockerAuth(
          ['NEO4J_AUTH=neo4j/test', 'NEO4J_AUTH=neo4j/test'],
          'test'
        )
      ).toBe(false);
      expect(hasExactNeo4jDockerAuth(undefined, 'test')).toBe(false);
    });

    it.each([
      [
        'no interrupted migration',
        { canonical: 'pinned', backup: 'missing', backupRunning: false } as const,
        'none',
      ],
      [
        'rename happened before replacement creation',
        {
          canonical: 'missing',
          backup: 'legacy-auto',
          backupRunning: false,
        } as const,
        'restore-legacy-name',
      ],
      [
        'replacement exists before final verification',
        {
          canonical: 'pinned',
          backup: 'legacy-auto',
          backupRunning: false,
        } as const,
        'resume-pinned-replacement',
      ],
    ])('plans %s safely', (_case, input, expected) => {
      expect(planLegacyGdsMigrationRecovery(input)).toBe(expected);
    });

    it.each([
      {
        canonical: 'pinned',
        backup: 'legacy-auto',
        backupRunning: true,
      },
      {
        canonical: 'pinned',
        backup: 'pinned',
        backupRunning: false,
      },
      {
        canonical: 'legacy-auto',
        backup: 'legacy-auto',
        backupRunning: false,
      },
    ] as const)('refuses ambiguous interrupted migration state %#', (input) => {
      expect(() => planLegacyGdsMigrationRecovery(input)).toThrow();
    });
  });

  describe('pinned Neo4j GDS provisioning', () => {
    it('downloads through host trust with a bounded HTTPS-only curl contract', () => {
      const output = join(tmpdir(), 'radarist-gds-download.jar');
      const args = buildPinnedGdsDownloadArgs(output);

      expect(args[0]).toBe('--disable');
      expect(args).toEqual(
        expect.arrayContaining([
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--tlsv1.2',
          '--connect-timeout',
          '20',
          '--max-time',
          '120',
          '--retry',
          '2',
          '--max-filesize',
          String(PINNED_NEO4J_GDS_MAX_DOWNLOAD_BYTES),
          '--output',
          output,
          '--url',
          PINNED_NEO4J_GDS_URL,
        ])
      );
      expect(args).not.toContain('--insecure');
      expect(args).not.toContain('-k');
      expect(PINNED_NEO4J_GDS_MIN_CURL_VERSION).toBe('8.4.0');
      expect(parseCurlVersion('curl 8.7.1 (arm64-apple-darwin)')).toBe('8.7.1');
      expect(parseCurlVersion('not curl')).toBeUndefined();
      expect(isSupportedPinnedGdsCurlVersion('8.4.0')).toBe(true);
      expect(isSupportedPinnedGdsCurlVersion('9.0.0')).toBe(true);
      expect(isSupportedPinnedGdsCurlVersion('8.3.9')).toBe(false);
      expect(isSupportedPinnedGdsCurlVersion('invalid')).toBe(false);
      expect(resolvePinnedGdsCurlCommand('darwin')).toBe('/usr/bin/curl');
      expect(resolvePinnedGdsCurlCommand('linux')).toBe('curl');
    });

    it('passes only host trust and proxy configuration to curl', () => {
      expect(
        buildPinnedGdsDownloadEnvironment({
          PATH: '/usr/bin',
          HTTPS_PROXY: 'http://proxy.invalid',
          SSL_CERT_FILE: '/trusted/corporate-ca.pem',
          GOOGLE_API_KEY: 'must-not-leak',
          NEO4J_PASSWORD: 'must-not-leak',
        })
      ).toEqual({
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy.invalid',
        SSL_CERT_FILE: '/trusted/corporate-ca.pem',
      });
    });

    it('executes curl with the exact filtered environment and a hard wall timeout', () => {
      const root = mkdtempSync(join(tmpdir(), 'radarist-gds-curl-contract-'));
      const secretKey = 'LOCAL017_SECRET_SENTINEL';
      const originalSecret = process.env[secretKey];
      try {
        const stub = join(root, 'curl-stub');
        const audit = join(root, 'environment-audit');
        const output = join(root, 'download.jar');
        process.env[secretKey] = 'ambient-secret';
        writeFileSync(
          stub,
          [
            '#!/bin/sh',
            `if [ "\${LOCAL017_SECRET_SENTINEL+x}" = x ]; then printf leaked > "${audit}"; exit 97; fi`,
            `printf filtered > "${audit}"`,
            'if [ "$1" = "--version" ]; then',
            "  printf 'curl 8.7.1 (test-stub)\\n'",
            '  exit 0',
            'fi',
            'while :; do :; done',
            '',
          ].join('\n')
        );
        chmodSync(stub, 0o700);
        const environment = buildPinnedGdsDownloadEnvironment({
          ...process.env,
          PATH: '/usr/bin:/bin',
        });

        expect(probePinnedGdsCurlVersion(stub, environment, 1_000)).toBe(
          '8.7.1'
        );
        expect(readFileSync(audit, 'utf8')).toBe('filtered');
        expect(() =>
          downloadPinnedGdsArtifact(stub, output, environment, 25)
        ).toThrow('exceeded its 25ms wall-clock limit');
      } finally {
        if (originalSecret === undefined) {
          delete process.env[secretKey];
        } else {
          process.env[secretKey] = originalSecret;
        }
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('builds a networkless checksum probe for the owned plugin volume', () => {
      const args = buildPinnedGdsArtifactProbeArgs(
        'radarist_neo4j_selftest_rc2_x_plugins'
      );
      const scriptIndex = args.indexOf('-euc') + 1;
      const script = args[scriptIndex];
      const mountIndexes = args.flatMap((arg, index) => (arg === '--mount' ? [index] : []));

      expect(args.slice(0, 12)).toEqual([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--user',
        '0:0',
        '--mount',
        'type=volume,source=radarist_neo4j_selftest_rc2_x_plugins,target=/plugins,volume-nocopy',
        '--entrypoint',
        '/bin/sh',
        'neo4j:5.15.0-community',
      ]);
      expect(mountIndexes).toEqual([7]);
      expect(args).not.toContain('-e');
      expect(args).not.toContain('--env');
      expect(args).toContain(PINNED_NEO4J_GDS_SHA256);
      expect(script).toContain('checksum_matches "$target"');
      expect(script).toContain(
        `exit ${PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE}`
      );
      expect(script).not.toContain('wget');
      expect(script).not.toContain('curl');
    });

    it('imports one host-verified file with no network and an atomic double-checksum', () => {
      const root = mkdtempSync(join(tmpdir(), 'radarist-gds-import-contract-'));
      try {
        const artifact = join(root, 'graph-data-science.jar');
        writeFileSync(artifact, 'synthetic-artifact');
        const args = buildPinnedGdsArtifactImportArgs(
          'radarist_neo4j_selftest_rc2_x_plugins',
          artifact
        );
        const scriptIndex = args.indexOf('-euc') + 1;
        const script = args[scriptIndex];
        const mountIndexes = args.flatMap((arg, index) =>
          arg === '--mount' ? [index] : []
        );

        expect(args.slice(0, 7)).toEqual([
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--user',
          '0:0',
        ]);
        expect(mountIndexes).toEqual([7, 9]);
        expect(args[mountIndexes[0] + 1]).toBe(
          'type=volume,source=radarist_neo4j_selftest_rc2_x_plugins,target=/plugins,volume-nocopy'
        );
        expect(args[mountIndexes[1] + 1]).toContain(
          'target=/gds-source.jar,readonly'
        );
        expect(args).not.toContain('-e');
        expect(args).not.toContain('--env');
        expect(script).toContain('checksum_matches "$source"');
        expect(script).toContain('mktemp "$target".tmp.XXXXXX');
        expect(script).toContain('cp -- "$source" "$temp"');
        expect(script).toContain('if ! checksum_matches "$temp"; then');
        expect(script).toContain('chown "$owner_id:$group_id" "$temp"');
        expect(script).toContain('chmod 0644 "$temp"');
        expect(script.indexOf('checksum_matches "$source"')).toBeLessThan(
          script.indexOf('cp -- "$source" "$temp"')
        );
        expect(script.indexOf('checksum_matches "$temp"')).toBeLessThan(
          script.indexOf('mv -f -- "$temp" "$target"')
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([
      '',
      'radarist_neo4j_data',
      'radarist_neo4j_plugins_extra',
      'foreign_neo4j_plugins',
      'radarist_neo4j_plugins:/host',
      'radarist_neo4j_plugins,source=/etc',
      'radarist_neo4j_plugins\n--mount=type=bind,source=/,target=/host',
      'radarist_neo4j_$(touch_exploit)_plugins',
    ])('rejects a mismatched or injectable plugin volume name: %p', (volume) => {
      expect(() => buildPinnedGdsArtifactProbeArgs(volume)).toThrow(
        /Invalid owned Neo4j plugin volume name/
      );
    });

    it.each([
      'relative.jar',
      '/tmp/bad,source=/etc/passwd',
      '/tmp/bad\n--mount=type=bind',
      '/tmp/bad\0jar',
    ])('rejects an unsafe host artifact path: %p', (artifact) => {
      expect(() =>
        buildPinnedGdsArtifactImportArgs('radarist_neo4j_plugins', artifact)
      ).toThrow(/safe absolute path/);
    });

    it('preserves the prior artifact when the host artifact checksum mismatches', () => {
      const root = mkdtempSync(join(tmpdir(), 'radarist-gds-provisioning-'));
      try {
        const pluginDirectory = join(root, 'plugins');
        const stubDirectory = join(root, 'bin');
        const source = join(root, 'graph-data-science.jar');
        const target = join(pluginDirectory, 'graph-data-science.jar');
        mkdirSync(pluginDirectory);
        mkdirSync(stubDirectory);
        writeFileSync(source, 'corrupt-download');
        writeFileSync(target, 'prior-artifact');

        const shaStub = join(stubDirectory, 'sha256sum');
        writeFileSync(shaStub, '#!/bin/sh\nexit 1\n');
        chmodSync(shaStub, 0o755);

        const args = buildPinnedGdsArtifactImportArgs(
          'radarist_neo4j_plugins',
          source
        );
        const scriptIndex = args.indexOf('-euc') + 1;
        const shellArgs = args.slice(scriptIndex + 1);
        shellArgs[1] = source;
        shellArgs[2] = target;
        shellArgs[4] = String(process.getuid?.() ?? 0);
        shellArgs[5] = String(process.getgid?.() ?? 0);
        const result = spawnSync('/bin/sh', ['-euc', args[scriptIndex], ...shellArgs], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH ?? ''}` },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'failed checksum verification; refusing to install'
        );
        expect(readFileSync(target, 'utf8')).toBe('prior-artifact');
        expect(readdirSync(pluginDirectory)).toEqual(['graph-data-science.jar']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('accepts only the exact unambiguous set of named Neo4j volume mounts', () => {
    const mounts = JSON.stringify(
      expectedMounts.map(({ name, destination }) => ({
        Type: 'volume',
        Name: name,
        Destination: destination,
        Driver: 'local',
        RW: true,
      }))
    );

    expect(hasExpectedDockerNamedVolumeMounts(mounts, expectedMounts)).toBe(true);
  });

  it.each([
    ['invalid JSON', 'not-json'],
    ['a non-array payload', '{}'],
    [
      'a missing mount',
      JSON.stringify(
        expectedMounts.slice(0, 3).map(({ name, destination }) => ({
          Type: 'volume',
          Name: name,
          Destination: destination,
        }))
      ),
    ],
    [
      'a bind mount',
      JSON.stringify([
        ...expectedMounts.slice(0, 3).map(({ name, destination }) => ({
          Type: 'volume',
          Name: name,
          Destination: destination,
        })),
        {
          Type: 'bind',
          Name: expectedMounts[3].name,
          Destination: expectedMounts[3].destination,
        },
      ]),
    ],
    [
      'an unexpected volume name',
      JSON.stringify(
        expectedMounts.map(({ name, destination }, index) => ({
          Type: 'volume',
          Name: index === 0 ? 'unowned_data' : name,
          Destination: destination,
        }))
      ),
    ],
    [
      'an unexpected destination',
      JSON.stringify(
        expectedMounts.map(({ name, destination }, index) => ({
          Type: 'volume',
          Name: name,
          Destination: index === 0 ? '/wrong-data' : destination,
        }))
      ),
    ],
    [
      'an extra mount',
      JSON.stringify([
        ...expectedMounts.map(({ name, destination }) => ({
          Type: 'volume',
          Name: name,
          Destination: destination,
        })),
        { Type: 'volume', Name: 'unexpected', Destination: '/unexpected' },
      ]),
    ],
    [
      'a read-only mount',
      JSON.stringify(
        expectedMounts.map(({ name, destination }, index) => ({
          Type: 'volume',
          Name: name,
          Destination: destination,
          RW: index !== 0,
        }))
      ),
    ],
    [
      'a duplicated mount identity',
      JSON.stringify(
        expectedMounts.map(({ name, destination }, index) => ({
          Type: 'volume',
          Name: index === 1 ? expectedMounts[0].name : name,
          Destination: index === 1 ? expectedMounts[0].destination : destination,
        }))
      ),
    ],
  ])('rejects %s in Docker Mounts JSON', (_case, mounts) => {
    expect(hasExpectedDockerNamedVolumeMounts(mounts, expectedMounts)).toBe(false);
  });

  it('plans creation for missing volumes only after validating existing ownership', () => {
    expect(
      planMissingDockerVolumes(
        expectedMounts.map(({ name }) => name),
        [
          {
            name: 'radarist_neo4j_data',
            runtimeLabel: 'durable:default',
            driver: 'local',
            scope: 'local',
            optionsJson: 'null',
          },
          {
            name: 'radarist_neo4j_import',
            runtimeLabel: 'durable:default',
            driver: 'local',
            scope: 'local',
            optionsJson: 'null',
          },
        ],
        'durable:default'
      )
    ).toEqual(['radarist_neo4j_logs', 'radarist_neo4j_plugins']);
  });

  it.each([
    ['a missing label', undefined],
    ['a wrong profile label', 'durable:selftest'],
    ['an ephemeral label', 'ephemeral:default'],
  ])('refuses to adopt an existing canonical volume with %s', (_case, runtimeLabel) => {
    expect(() =>
      planMissingDockerVolumes(
        expectedMounts.map(({ name }) => name),
        [
          {
            name: 'radarist_neo4j_data',
            runtimeLabel,
            driver: 'local',
            scope: 'local',
            optionsJson: 'null',
          },
        ],
        'durable:default'
      )
    ).toThrow(/radarist_neo4j_data.*ownership label/);
  });

  it('rejects duplicate expected or observed volume identities as ambiguous', () => {
    expect(() =>
      planMissingDockerVolumes(['radarist_neo4j_data', 'radarist_neo4j_data'], [], 'durable:default')
    ).toThrow(/duplicate expected Docker volume/);
    expect(() =>
      planMissingDockerVolumes(
        ['radarist_neo4j_data'],
        [
          {
            name: 'radarist_neo4j_data',
            runtimeLabel: 'durable:default',
            driver: 'local',
            scope: 'local',
            optionsJson: 'null',
          },
          {
            name: 'radarist_neo4j_data',
            runtimeLabel: 'durable:default',
            driver: 'local',
            scope: 'local',
            optionsJson: 'null',
          },
        ],
        'durable:default'
      )
    ).toThrow(/duplicate observed Docker volume/);
  });

  it.each([
    ['a non-local driver', 'nfs', 'local', 'null'],
    ['a non-local scope', 'local', 'global', 'null'],
    ['an unreadable driver', undefined, 'local', 'null'],
    ['an unreadable scope', 'local', undefined, 'null'],
    ['local bind driver options', 'local', 'local', '{"type":"none","o":"bind"}'],
    ['unreadable driver options', 'local', 'local', undefined],
  ])('refuses to adopt a canonical volume with %s', (_case, driver, scope, optionsJson) => {
    expect(() =>
      planMissingDockerVolumes(
        ['radarist_neo4j_data'],
        [
          {
            name: 'radarist_neo4j_data',
            runtimeLabel: 'durable:default',
            driver,
            scope,
            optionsJson,
          },
        ],
        'durable:default'
      )
    ).toThrow(/local driver, local scope, and no driver options/);
  });

  it('selects the default profile when no profile flag is provided', () => {
    expect(parseProfileArg([])).toBe(DEMO_PROFILES.default);
  });

  it('selects the selftest profile from either supported flag form', () => {
    expect(parseProfileArg(['--profile', 'selftest'])).toBe(DEMO_PROFILES.selftest);
    expect(parseProfileArg(['--profile=selftest'])).toBe(DEMO_PROFILES.selftest);
  });

  it('refuses unknown or missing explicit profile names', () => {
    expect(() => getProfileConfig('windows')).toThrow(/Unknown local runtime profile/);
    expect(() => parseProfileArg(['--profile'])).toThrow(/requires an explicit profile/);
  });

  it('selects explicit seed and durability modes without ambiguous combinations', () => {
    expect(parseDemoSeedMode(['--blank'])).toBe('blank');
    expect(parseDemoSeedMode(['--showcase'])).toBe('showcase');
    expect(parseDemoSeedMode([])).toBe('showcase');
    expect(() => parseDemoSeedMode(['--blank', '--showcase'])).toThrow(/exactly one/);
    expect(parseDemoDurabilityMode([])).toBe('durable');
    expect(parseDemoDurabilityMode(['--persist'])).toBe('durable');
    expect(parseDemoDurabilityMode(['--ephemeral'])).toBe('ephemeral');
    expect(() => parseDemoDurabilityMode(['--persist', '--ephemeral'])).toThrow(/cannot be combined/);
  });

  it('refuses to pair a fresh durable Firebase workspace with existing user graph data', () => {
    expect(() =>
      assertFreshFirebaseGraphCompatibility({
        durabilityMode: 'durable',
        graphUserNodeCount: 4,
      })
    ).toThrow(/Fresh Firebase workspace refused/);
    expect(() =>
      assertFreshFirebaseGraphCompatibility({
        durabilityMode: 'durable',
        firebaseImportPath: '/verified/checkpoint',
        graphUserNodeCount: 4,
      })
    ).not.toThrow();
    expect(() =>
      assertFreshFirebaseGraphCompatibility({
        durabilityMode: 'ephemeral',
        graphUserNodeCount: 4,
      })
    ).toThrow(/Fresh Firebase workspace refused/);
    expect(() =>
      assertFreshFirebaseGraphCompatibility({
        durabilityMode: 'durable',
        graphUserNodeCount: Number.NaN,
      })
    ).toThrow(/invalid count/);
  });

  it('parses the complete launcher contract and rejects typos or repeated flags', () => {
    expect(
      parseDemoFullOptions(['--profile=selftest', '--blank', '--ephemeral', '--dev', '--skip-inngest'])
    ).toMatchObject({
      profile: { name: 'selftest' },
      seedMode: 'blank',
      durabilityMode: 'ephemeral',
      devMode: true,
      skipInngest: true,
    });
    expect(() => parseDemoFullOptions(['--ephemerl'])).toThrow(/Unknown demo:full argument/);
    expect(() => parseDemoFullOptions(['--dev', '--dev'])).toThrow(/at most once/);
  });

  it('serves the production build by default and reserves Turbopack for explicit HMR', () => {
    expect(buildDemoAppLaunchPlan(DEMO_PROFILES.default, false)).toEqual({
      command: 'npx',
      args: ['next', 'start', '-H', '127.0.0.1', '-p', '9002'],
    });
    expect(buildDemoAppLaunchPlan(DEMO_PROFILES.selftest, true)).toEqual({
      command: 'npx',
      args: ['next', 'dev', '--turbopack', '-H', '127.0.0.1', '-p', '9012'],
    });
  });

  it('builds the default local demo env with aligned Gemini aliases', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, { GOOGLE_GENAI_API_KEY: 'gemini-key' });

    expect(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe('demo-radarist');
    expect(env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8080');
    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:9099');
    expect(env.NEO4J_URI).toBe('bolt://127.0.0.1:7687');
    expect(env.RADARIST_GRAPH_RUNTIME_MODE).toBe('neo4j');
    expect(env.INNGEST_ENABLED).toBe('true');
    expect(env.INNGEST_DEV_URL).toBe('http://127.0.0.1:8288');
    expect(env.INNGEST_DEV).toBe('http://127.0.0.1:8288');
    expect(env.GOOGLE_GENAI_API_KEY).toBe('gemini-key');
    expect(env.GOOGLE_API_KEY).toBe('gemini-key');
    expect(env.GEMINI_API_KEY).toBe('gemini-key');
    expect(env.DISCOVERY_FEEDBACK_ENABLED).toBe('true');
  });

  it('preserves an explicit opt-out from the showcase feedback loop', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, { DISCOVERY_FEEDBACK_ENABLED: 'false' });

    expect(env.DISCOVERY_FEEDBACK_ENABLED).toBe('false');
  });

  it('builds the selftest env on alternate ports', () => {
    const env = buildDemoEnv(DEMO_PROFILES.selftest, {});

    expect(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe('demo-radarist-selftest');
    expect(env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:18080');
    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:19099');
    expect(env.NEO4J_URI).toBe('bolt://127.0.0.1:17687');
    expect(env.RADARIST_GRAPH_RUNTIME_MODE).toBe('neo4j');
    expect(env.INNGEST_DEV_URL).toBe('http://127.0.0.1:18288');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://127.0.0.1:9012');
  });

  it('OPS-004: derives IMPULSE_MCP_BASE_URL from the active profile app port', () => {
    // Default and selftest profiles must each mint a mission MCP base bound to
    // the app port the launcher actually starts — this is the single active-
    // runtime authority the agent config now trusts over ignored YAML.
    expect(buildDemoEnv(DEMO_PROFILES.default, {}).IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9002/api/mcp');
    expect(buildDemoEnv(DEMO_PROFILES.selftest, {}).IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9012/api/mcp');
  });

  it('OPS-004: derives IMPULSE_MCP_BASE_URL from a shifted (arbitrary-offset) profile', () => {
    // An acceptance/offset profile shifts every port; the MCP base must track
    // the shifted app port rather than the canonical default.
    const shifted: DemoProfileConfig = { ...DEMO_PROFILES.default, appPort: 9022 };
    expect(buildDemoEnv(shifted, {}).IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9022/api/mcp');
    expect(buildDemoEnv(shifted, {}).NEXT_PUBLIC_APP_URL).toBe('http://127.0.0.1:9022');
  });

  it('OPS-004: overwrites a stale developer IMPULSE_MCP_BASE_URL with the profile value', () => {
    // A stale `.env.local` value (wrong port) must never survive — the profile
    // app port is the authority, so buildDemoEnv regenerates it regardless of
    // the inherited value.
    const env = buildDemoEnv(DEMO_PROFILES.default, {
      IMPULSE_MCP_BASE_URL: 'http://127.0.0.1:9999/api/mcp',
    });
    expect(env.IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9002/api/mcp');
  });

  it('OPS-004: the doctor passes a valid generated IMPULSE_MCP_BASE_URL and fails a blanked/malformed one', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});
    const pass = validateDemoEnv(env).find((check) => check.label === 'IMPULSE_MCP_BASE_URL');
    expect(pass?.level).toBe('pass');
    expect(pass?.detail).toBe('http://127.0.0.1:9002/api/mcp');

    const blanked = { ...env, IMPULSE_MCP_BASE_URL: '' };
    expect(validateDemoEnv(blanked).find((check) => check.label === 'IMPULSE_MCP_BASE_URL')?.level).toBe('fail');

    const malformed = { ...env, IMPULSE_MCP_BASE_URL: 'http://127.0.0.1:9002/not-mcp' };
    expect(validateDemoEnv(malformed).find((check) => check.label === 'IMPULSE_MCP_BASE_URL')?.level).toBe('fail');
  });

  it('OPS-004: isValidMcpBaseUrl accepts an http(s) /api/mcp base and rejects everything else', () => {
    expect(isValidMcpBaseUrl('http://127.0.0.1:9002/api/mcp')).toBe(true);
    expect(isValidMcpBaseUrl('https://example.test/api/mcp/')).toBe(true);
    expect(isValidMcpBaseUrl('http://127.0.0.1:9002/api/mcp/entities')).toBe(false);
    expect(isValidMcpBaseUrl('http://127.0.0.1:9002')).toBe(false);
    expect(isValidMcpBaseUrl('bolt://127.0.0.1:7687/api/mcp')).toBe(false);
    expect(isValidMcpBaseUrl('not-a-url')).toBe(false);
    expect(isValidMcpBaseUrl(undefined)).toBe(false);
    expect(isValidMcpBaseUrl('')).toBe(false);
  });

  it('flags missing required values but only warns for AI placeholders', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});
    const checks = validateDemoEnv(env);

    expect(checks.filter((check) => check.level === 'fail')).toHaveLength(0);
    expect(checks.find((check) => check.label === 'ANTHROPIC_API_KEY')?.level).toBe('warn');
    expect(isPlaceholder('your-google-genai-api-key')).toBe(true);
  });

  it.each([
    ['INNGEST_DEV', { INNGEST_DEV: 'http://127.0.0.1:8288' }],
    ['INNGEST_BASE_URL', { INNGEST_BASE_URL: 'https://inngest.example.test/base/' }],
  ])('accepts SDK-effective routing through %s', (key, routingEnv) => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});
    delete env.INNGEST_DEV;
    Object.assign(env, routingEnv);

    expect(resolveInngestSdkRouting(env)?.key).toBe(key);
    expect(validateDemoEnv(env).find((check) => check.label === 'INNGEST SDK routing')?.level).toBe('pass');
  });

  it('rejects helper aliases when no SDK-effective routing URL is persisted', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});
    delete env.INNGEST_DEV;
    delete env.INNGEST_BASE_URL;

    expect(env.INNGEST_DEV_URL).toBe('http://127.0.0.1:8288');
    expect(env.INNGEST_DEV_SERVER_URL).toBe('http://127.0.0.1:8288');
    expect(resolveInngestSdkRouting(env)).toBeUndefined();
    expect(validateDemoEnv(env).find((check) => check.label === 'INNGEST SDK routing')).toEqual({
      level: 'fail',
      label: 'INNGEST SDK routing',
      detail: 'set INNGEST_DEV or INNGEST_BASE_URL to a valid http(s) URL',
    });
  });

  it('rejects boolean or malformed INNGEST_DEV values instead of assuming local routing', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});

    for (const value of ['true', 'not-a-url']) {
      env.INNGEST_DEV = value;
      expect(resolveInngestSdkRouting(env)).toBeUndefined();
      expect(validateDemoEnv(env).find((check) => check.label === 'INNGEST SDK routing')?.level).toBe('fail');
    }
  });

  it('rejects an invalid INNGEST_BASE_URL instead of falling through to INNGEST_DEV', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});
    env.INNGEST_BASE_URL = 'not-a-url';

    expect(resolveInngestSdkRouting(env)).toBeUndefined();
    expect(validateDemoEnv(env).find((check) => check.label === 'INNGEST SDK routing')?.level).toBe('fail');
  });

  it('never exposes configured passwords, internal keys, API keys, tokens, or secrets', () => {
    const secretValues = {
      NEO4J_PASSWORD: 'neo4j-password-regression-canary',
      IMPULSE_INTERNAL_KEY: 'internal-key-regression-canary',
      GOOGLE_API_KEY: 'google-api-key-regression-canary',
      GEMINI_API_KEY: 'gemini-api-key-regression-canary',
      GOOGLE_GENAI_API_KEY: 'genai-api-key-regression-canary',
      ANTHROPIC_API_KEY: 'anthropic-api-key-regression-canary',
    };
    const env = { ...buildDemoEnv(DEMO_PROFILES.default, {}), ...secretValues };
    const checks = validateDemoEnv(env);
    const renderedChecks = JSON.stringify(checks);

    for (const value of Object.values(secretValues)) {
      expect(renderedChecks).not.toContain(value);
    }
    expect(checks.find((check) => check.label === 'NEO4J_PASSWORD')?.detail).toBe('configured');
    expect(checks.find((check) => check.label === 'IMPULSE_INTERNAL_KEY')?.detail).toBe('configured');
  });

  it('redacts unknown environment values by default while preserving allowlisted diagnostics', () => {
    expect(formatDoctorEnvDetail('SERVICE_PASSWORD', 'password-canary', 'missing')).toBe('configured');
    expect(formatDoctorEnvDetail('SERVICE_API_KEY', 'api-key-canary', 'missing')).toBe('configured');
    expect(formatDoctorEnvDetail('SERVICE_ACCESS_TOKEN', 'token-canary', 'missing')).toBe('configured');
    expect(formatDoctorEnvDetail('CLIENT_SECRET', 'secret-canary', 'missing')).toBe('configured');
    expect(formatDoctorEnvDetail('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080', 'missing')).toBe('127.0.0.1:8080');
    expect(formatDoctorEnvDetail('FIRESTORE_EMULATOR_HOST', undefined, 'missing or placeholder')).toBe(
      'missing or placeholder'
    );
  });

  it('serializes managed and preserved env values', () => {
    const text = serializeDemoEnv(
      buildDemoEnv(DEMO_PROFILES.default, {
        CUSTOM_LOCAL_VALUE: 'kept',
        GOOGLE_API_KEY: 'gemini-key',
      })
    );

    expect(text).toContain('NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
    expect(text).toContain('GOOGLE_GENAI_API_KEY=gemini-key');
    expect(text).toContain('DISCOVERY_FEEDBACK_ENABLED=true');
    expect(text).toContain('CUSTOM_LOCAL_VALUE=kept');
  });
});

describe('ensureDemoEnvFile (demo:full self-bootstrap)', () => {
  let dir: string;
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'radarist-demo-env-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a missing env file with the same output as setup:local', () => {
    const result = ensureDemoEnvFile(DEMO_PROFILES.default);

    expect(result.created).toBe(true);
    const filePath = join(dir, '.env.local');
    expect(existsSync(filePath)).toBe(true);

    const written = dotenv.parse(readFileSync(filePath, 'utf8'));
    // Secrets are generated, not left as placeholders (setup:local parity)
    expect(written.NEO4J_PASSWORD).toMatch(/^radarist-neo4j-[0-9a-f]{36}$/);
    expect(written.IMPULSE_INTERNAL_KEY).toMatch(/^radarist-internal-[0-9a-f]{36}$/);
    expect(written.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe('demo-radarist');
    expect(result.env.NEO4J_PASSWORD).toBe(written.NEO4J_PASSWORD);
    // Identical to a fresh setup:local run: no fail-level checks
    expect(validateDemoEnv(result.env).filter((check) => check.level === 'fail')).toHaveLength(0);
  });

  it('supports profiles: writes the selftest env file on selftest ports', () => {
    const result = ensureDemoEnvFile(DEMO_PROFILES.selftest);

    expect(result.created).toBe(true);
    expect(existsSync(join(dir, '.env.selftest.local'))).toBe(true);
    expect(result.env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:18080');
    expect(result.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe('demo-radarist-selftest');
  });

  it('replaces copied Firebase identity values with the selected profile identity', () => {
    const filePath = join(dir, '.env.selftest.local');
    writeFileSync(
      filePath,
      [
        'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-radarist.firebaseapp.com',
        'NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-radarist',
        'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=demo-radarist.appspot.com',
        'FIREBASE_PROJECT_ID=demo-radarist',
        'GOOGLE_CLOUD_PROJECT=demo-radarist',
        'GCLOUD_PROJECT=demo-radarist',
        'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080',
        'INNGEST_DEV=http://127.0.0.1:8288',
        'NEO4J_URI=bolt://127.0.0.1:7687',
        'CUSTOM_LOCAL_VALUE=kept',
        '',
      ].join('\n')
    );

    const result = ensureDemoEnvFile(DEMO_PROFILES.selftest);
    const written = dotenv.parse(readFileSync(filePath, 'utf8'));

    expect(result.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe('demo-radarist-selftest');
    expect(written).toMatchObject({
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-radarist-selftest.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-radarist-selftest.appspot.com',
      FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
      GOOGLE_CLOUD_PROJECT: 'demo-radarist-selftest',
      GCLOUD_PROJECT: 'demo-radarist-selftest',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
      INNGEST_DEV: 'http://127.0.0.1:18288',
      NEO4J_URI: 'bolt://127.0.0.1:17687',
      CUSTOM_LOCAL_VALUE: 'kept',
    });
  });

  it('leaves an existing env file untouched so secrets stay stable', () => {
    const first = ensureDemoEnvFile(DEMO_PROFILES.default);
    const second = ensureDemoEnvFile(DEMO_PROFILES.default);

    expect(second.created).toBe(false);
    expect(second.env.NEO4J_PASSWORD).toBe(first.env.NEO4J_PASSWORD);
    expect(second.env.IMPULSE_INTERNAL_KEY).toBe(first.env.IMPULSE_INTERNAL_KEY);
  });

  it('fills an incomplete env while preserving secrets and repairing profile-owned routing', () => {
    const filePath = join(dir, '.env.local');
    writeFileSync(
      filePath,
      [
        'NEO4J_URI=bolt://explicit-host:7777',
        'NEO4J_USER=explicit-user',
        'DISCOVERY_FEEDBACK_ENABLED=false',
        'CUSTOM_LOCAL_VALUE=kept',
        '',
      ].join('\n')
    );

    const first = ensureDemoEnvFile(DEMO_PROFILES.default);
    const firstWritten = dotenv.parse(readFileSync(filePath, 'utf8'));
    const second = ensureDemoEnvFile(DEMO_PROFILES.default);
    const secondWritten = dotenv.parse(readFileSync(filePath, 'utf8'));

    expect(first.created).toBe(false);
    expect(firstWritten.NEO4J_PASSWORD).toMatch(/^radarist-neo4j-[0-9a-f]{36}$/);
    expect(firstWritten.IMPULSE_INTERNAL_KEY).toMatch(/^radarist-internal-[0-9a-f]{36}$/);
    expect(firstWritten.NEO4J_URI).toBe('bolt://127.0.0.1:7687');
    expect(firstWritten.NEO4J_USER).toBe('explicit-user');
    expect(firstWritten.DISCOVERY_FEEDBACK_ENABLED).toBe('false');
    expect(firstWritten.CUSTOM_LOCAL_VALUE).toBe('kept');
    expect(secondWritten).toEqual(firstWritten);
    expect(second.env.NEO4J_PASSWORD).toBe(firstWritten.NEO4J_PASSWORD);
    expect(second.env.IMPULSE_INTERNAL_KEY).toBe(firstWritten.IMPULSE_INTERNAL_KEY);
    expect(second.env.INNGEST_DEV).toBe(firstWritten.INNGEST_DEV);
  });

  it('OPS-004: persists the profile IMPULSE_MCP_BASE_URL and repairs a stale developer value', () => {
    const filePath = join(dir, '.env.local');
    // A stale developer env pins the wrong port — the exact OPS-004 shape.
    writeFileSync(
      filePath,
      ['IMPULSE_MCP_BASE_URL=http://127.0.0.1:9999/api/mcp', 'CUSTOM_LOCAL_VALUE=kept', ''].join('\n')
    );

    const first = ensureDemoEnvFile(DEMO_PROFILES.default);
    const firstWritten = dotenv.parse(readFileSync(filePath, 'utf8'));
    const second = ensureDemoEnvFile(DEMO_PROFILES.default);
    const secondWritten = dotenv.parse(readFileSync(filePath, 'utf8'));

    // The profile app port is the authority — the stale value is overwritten.
    expect(firstWritten.IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9002/api/mcp');
    expect(first.env.IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9002/api/mcp');
    expect(firstWritten.CUSTOM_LOCAL_VALUE).toBe('kept');
    // Idempotent: a second run neither rewrites nor drifts the value.
    expect(secondWritten).toEqual(firstWritten);
    expect(second.env.IMPULSE_MCP_BASE_URL).toBe('http://127.0.0.1:9002/api/mcp');
    // The persisted value passes the doctor.
    expect(validateDemoEnv(second.env).find((check) => check.label === 'IMPULSE_MCP_BASE_URL')?.level).toBe('pass');
  });

  it('repairs copied scaffold secrets and returns the exact persisted routing and secrets', () => {
    const filePath = join(dir, '.env.local');
    const examplePath = join(__dirname, '..', '..', '.env.example');
    writeFileSync(filePath, readFileSync(examplePath, 'utf8'));

    const first = ensureDemoEnvFile(DEMO_PROFILES.default);
    const firstWritten = dotenv.parse(readFileSync(filePath, 'utf8'));
    const second = ensureDemoEnvFile(DEMO_PROFILES.default);
    const secondWritten = dotenv.parse(readFileSync(filePath, 'utf8'));

    expect(firstWritten.IMPULSE_INTERNAL_KEY).toMatch(/^radarist-internal-[0-9a-f]{36}$/);
    expect(firstWritten.IMPULSE_INTERNAL_KEY).not.toBe('replace-with-any-random-string');
    expect(firstWritten.NEO4J_PASSWORD).toMatch(/^radarist-neo4j-[0-9a-f]{36}$/);
    expect(firstWritten.INNGEST_DEV).toBe('http://127.0.0.1:8288');
    expect(first.env.IMPULSE_INTERNAL_KEY).toBe(firstWritten.IMPULSE_INTERNAL_KEY);
    expect(first.env.NEO4J_PASSWORD).toBe(firstWritten.NEO4J_PASSWORD);
    expect(first.env.INNGEST_DEV).toBe(firstWritten.INNGEST_DEV);
    expect(second.env.IMPULSE_INTERNAL_KEY).toBe(firstWritten.IMPULSE_INTERNAL_KEY);
    expect(second.env.NEO4J_PASSWORD).toBe(firstWritten.NEO4J_PASSWORD);
    expect(second.env.INNGEST_DEV).toBe(firstWritten.INNGEST_DEV);
    expect(secondWritten).toEqual(firstWritten);
  });

  it('repairs a non-URL INNGEST_DEV so returned routing matches the persisted value', () => {
    const filePath = join(dir, '.env.local');
    writeFileSync(filePath, 'INNGEST_DEV=true\n');

    const result = ensureDemoEnvFile(DEMO_PROFILES.default);
    const written = dotenv.parse(readFileSync(filePath, 'utf8'));

    expect(written.INNGEST_DEV).toBe('http://127.0.0.1:8288');
    expect(result.env.INNGEST_DEV).toBe(written.INNGEST_DEV);
    expect(resolveInngestSdkRouting(result.env)).toEqual({
      key: 'INNGEST_DEV',
      url: written.INNGEST_DEV,
    });
  });

  it('does not let runtime-generated defaults satisfy doctor-style persisted checks', () => {
    const runtimeEnv = buildDemoEnv(DEMO_PROFILES.default, {});
    const checks = validateDemoEnv(runtimeEnv, {});

    expect(checks.find((check) => check.label === 'NEO4J_PASSWORD')).toEqual({
      level: 'fail',
      label: 'NEO4J_PASSWORD',
      detail: 'missing or placeholder',
    });
    expect(checks.find((check) => check.label === 'IMPULSE_INTERNAL_KEY')?.level).toBe('fail');
    expect(checks.find((check) => check.label === 'INNGEST SDK routing')?.level).toBe('fail');
  });

  it('mechanically disables direct graph access in every plain-demo child process', () => {
    expect(packageJson.scripts.demo).toContain('RADARIST_GRAPH_RUNTIME_MODE=disabled');
    expect(packageJson.scripts.demo).toContain('NEO4J_URI=');
    expect(packageJson.scripts['demo:inner']).toContain('RADARIST_GRAPH_RUNTIME_MODE=disabled');
    expect(packageJson.scripts['demo:inner']).toContain('NEO4J_URI=');
    expect(packageJson.scripts['seed:demo:firestore-only']).toContain('RADARIST_GRAPH_RUNTIME_MODE=disabled');
  });

  it('keeps generic browser startup graph-disabled and the owned graph lane explicit', () => {
    expect(packageJson.scripts['e2e:serve']).toContain('RADARIST_GRAPH_RUNTIME_MODE=disabled');
    expect(packageJson.scripts['e2e:serve']).toContain('NEO4J_URI=');
    expect(packageJson.scripts['e2e:serve:graph']).toContain('RADARIST_GRAPH_RUNTIME_MODE=neo4j');
    expect(packageJson.scripts['e2e:serve:graph']).toContain('NEO4J_URI=bolt://127.0.0.1:17692');
  });
});

describe('OPS-003 deprecated Inngest SDK environment', () => {
  const ORIGINAL = process.env.INNGEST_DEVSERVER_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INNGEST_DEVSERVER_URL;
    else process.env.INNGEST_DEVSERVER_URL = ORIGINAL;
  });

  it('never mints the deprecated alias into the demo environment', () => {
    const env = buildDemoEnv(DEMO_PROFILES.default, {});
    expect(env.INNGEST_DEVSERVER_URL).toBeUndefined();
    // The canonical routing variable and the app-local health alias survive.
    expect(env.INNGEST_DEV).toBe('http://127.0.0.1:8288');
    expect(env.INNGEST_DEV_SERVER_URL).toBe('http://127.0.0.1:8288');
  });

  it('strips an inherited deprecated alias so SDK-owning children never see it', () => {
    // A developer shell or stale .env.local can still export it, and
    // envForChild inherits the whole parent environment, so the strip must
    // happen there rather than only at mint time.
    process.env.INNGEST_DEVSERVER_URL = 'http://127.0.0.1:8288';
    const childEnv = envForChild(buildDemoEnv(DEMO_PROFILES.default, {}));
    expect(childEnv.INNGEST_DEVSERVER_URL).toBeUndefined();
    expect(childEnv.INNGEST_DEV).toBe('http://127.0.0.1:8288');
  });

  it('strips every declared deprecated key', () => {
    for (const key of DEPRECATED_INNGEST_SDK_ENV_KEYS) {
      process.env[key] = 'http://127.0.0.1:8288';
    }
    const childEnv = envForChild(buildDemoEnv(DEMO_PROFILES.default, {}));
    for (const key of DEPRECATED_INNGEST_SDK_ENV_KEYS) {
      expect(childEnv[key]).toBeUndefined();
      delete process.env[key];
    }
  });
});

describe('generated env sectioning', () => {
  it('writes every managed key exactly once, under its declared section', () => {
    const serialized = serializeDemoEnv(buildDemoEnv(DEMO_PROFILES.default, {}));
    const sections = new Map<string, string[]>();
    let current = '';
    for (const line of serialized.split('\n')) {
      if (line.startsWith('# ') && !line.startsWith('# ===')) {
        if (line.includes('Radarist local') || line.includes('Generated by')) continue;
        current = line;
        sections.set(current, []);
        continue;
      }
      const key = line.split('=')[0];
      if (key && current) sections.get(current)!.push(key);
    }

    const emitted = [...sections.values()].flat();
    // Positional slicing previously re-sectioned every later key whenever one
    // was added or removed; assert placement, not just presence.
    for (const key of MANAGED_ENV_KEYS) {
      expect(emitted.filter((candidate) => candidate === key)).toHaveLength(1);
    }
    expect(sections.get('# Inngest and internal service auth')).toEqual([
      'INNGEST_ENABLED',
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
      'INNGEST_DEV_URL',
      'INNGEST_DEV_SERVER_URL',
      'INNGEST_DEV',
      'IMPULSE_INTERNAL_KEY',
    ]);
    expect(sections.get('# Safe showcase feature flags')).toEqual([
      'CLAUDE_CHAT_ENABLED',
      'DISCOVERY_FEEDBACK_ENABLED',
    ]);
    expect(sections.get('# Demo login and app URL')).toEqual([
      'E2E_USER_EMAIL',
      'E2E_USER_PASSWORD',
      'NEXT_PUBLIC_APP_URL',
      'IMPULSE_MCP_BASE_URL',
    ]);
  });
});
