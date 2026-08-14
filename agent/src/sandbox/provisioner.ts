/**
 * Per-mission workspace provisioning.
 *
 * The template (skills, hooks, settings, gitignore) is baked into the image
 * and copied into an empty workspace volume by the container entrypoint. The
 * host-side refresh below reasserts the current package's trusted control
 * plane whenever a persisted workspace is reused.
 *
 * Env crossing the boundary is an explicit allowlist resolved here; the
 * full host env NEVER reaches the container.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { fullImageName, type BuildConfig } from './config.js';
import { containerNameFor, volumeNameFor } from './drivers/docker.js';
import { browserCacheMountFor } from './browser-cache.js';
import { resetWorkspaceGitControlPlane, runTrustedWorkspaceGit } from './git-control-plane.js';
import { INITIAL_STATUS } from './status.js';
import { pickHostPort, type SandboxDriver, type SandboxRef } from './types.js';

export interface ProvisionResult {
  ref: SandboxRef;
  /** Non-fatal setup notes (e.g. optional MCP keys absent) — caller logs them. */
  warnings: string[];
}

export interface ControlPlaneRefreshResult {
  /** True only when the trusted control-plane tree required a repair commit. */
  changed: boolean;
  /** The supervisor repair commit, or null when the trusted tree was already current. */
  commit: string | null;
}

const CONTROL_PLANE_COMMIT_MESSAGE = 'chore: supervisor refresh trusted control plane';
const SESSION_ENV_ALLOWLIST_PATH = '.claude/.supervisor-env-allowlist';

function authorizedContainerEnvKeys(cfg: BuildConfig, platformServers: string[]): string[] {
  const wanted = new Set(cfg.envAllowlist);
  if (platformServers.length > 0) wanted.add('IMPULSE_INTERNAL_KEY');
  if (cfg.mcp.enableWeb) {
    wanted.add('EXA_API_KEY');
    wanted.add('FIRECRAWL_API_KEY');
  }
  if (cfg.mcp.enableGithub) wanted.add('GITHUB_TOKEN');
  return [...wanted].sort();
}

/**
 * Values that crossed the agent boundary and must never be present in a
 * published preview workspace. Missing host values are ignored so a retained
 * artifact remains restartable after optional integrations are disabled.
 */
export function resolveContainerSecretValues(
  cfg: BuildConfig,
  hostEnv: Record<string, string | undefined> = process.env,
  platformServers: string[] = cfg.mcp.platformServers
): string[] {
  const values = authorizedContainerEnvKeys(cfg, platformServers)
    .map((key) => hostEnv[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(values)];
}

function renderSessionEnvAllowlist(cfg: BuildConfig, platformServers: string[]): string {
  return authorizedContainerEnvKeys(cfg, platformServers).join('\n') + '\n';
}

/**
 * The platform MCP servers an artifact kind may reach. Evaluation missions
 * clone untrusted repos, so by default they get NO platform servers (and
 * therefore no admin key — see resolveContainerEnv): the graph context they
 * need is already baked into the brief by the composer, and the supervisor
 * does all writeback OUTSIDE the sandbox. Solution artifacts keep the
 * configured set.
 */
export function platformServersFor(cfg: BuildConfig, artifactKind?: string): string[] {
  return artifactKind === 'evaluation' ? cfg.mcp.evalPlatformServers : cfg.mcp.platformServers;
}

/** Resolve the explicit env allowlist; throws when required keys are absent. */
export function resolveContainerEnv(
  cfg: BuildConfig,
  hostEnv: Record<string, string | undefined> = process.env,
  platformServers: string[] = cfg.mcp.platformServers
): { env: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const env: Record<string, string> = {};

  const wanted = authorizedContainerEnvKeys(cfg, platformServers);

  for (const key of wanted) {
    const value = hostEnv[key];
    if (value) {
      env[key] = value;
    } else if (key === 'ANTHROPIC_API_KEY') {
      throw new Error(
        'ANTHROPIC_API_KEY is required for build missions (the in-sandbox Claude Code bills against it) and is not set.'
      );
    } else if (key === 'IMPULSE_INTERNAL_KEY') {
      throw new Error(
        `IMPULSE_INTERNAL_KEY is not set but platform MCP servers are enabled (${platformServers.join(', ')}). Set the key or expose no platform servers for this mission.`
      );
    } else {
      warnings.push(`env allowlist key ${key} is not set on the host — omitted from the sandbox`);
    }
  }

  // BUILD-015/020: actively SET the in-sandbox `claude -p` output-token ceiling.
  // The CLI defaults CLAUDE_CODE_MAX_OUTPUT_TOKENS to 32000; unset, the box
  // truncates larger single responses. We set the validated 64000 (the CLI's
  // hard maximum — never 128000, which the CLI caps/errors on regardless of the
  // model's larger API ceiling). Set explicitly, not allow-listed: the host
  // almost never exports this, so allow-listing an absent var is a silent no-op.
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(cfg.sessions.maxOutputTokens);

  return { env, warnings };
}

/** Render the workspace .mcp.json from config — pure, snapshot-tested. */
export function renderMcpJson(
  cfg: BuildConfig,
  missionId: string,
  platformServers: string[] = cfg.mcp.platformServers
): string {
  const servers: Record<string, unknown> = {};
  for (const name of platformServers) {
    servers[`impulse-${name}`] = {
      type: 'http',
      url: `${cfg.mcp.hostBaseUrl.replace(/\/+$/, '')}/${name}`,
      headers: {
        // ${VAR} is expanded by Claude Code from the container env at load
        // time, so the key never lands in a file git might track.
        'x-api-key': '${IMPULSE_INTERNAL_KEY}',
        'x-mission-id': missionId,
      },
    };
  }
  servers.memory = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: { MEMORY_FILE_PATH: `${cfg.workspacePath}/.memory/graph.json` },
  };
  if (cfg.mcp.enableWeb) {
    servers.exa = {
      command: 'npx',
      args: ['-y', 'exa-mcp-server'],
      env: { EXA_API_KEY: '${EXA_API_KEY}' },
    };
    servers.firecrawl = {
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      env: { FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' },
    };
  }
  if (cfg.mcp.enableGithub) {
    servers.github = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
}

/**
 * Write a file inside the sandbox via exec + stdin. Deliberately NOT
 * `docker cp`: cp preserves host uids, and files owned by the host user
 * are unwritable for the container's unprivileged session user (the
 * Phase 1 gate failed exactly this way).
 */
export async function writeWorkspaceFile(
  driver: SandboxDriver,
  ref: SandboxRef,
  relPath: string,
  content: string
): Promise<void> {
  const dir = path.posix.dirname(relPath);
  const result = await driver.exec(ref, ['sh', '-c', `mkdir -p '${dir}' && cat > '${relPath}'`], { input: content });
  if (result.code !== 0) {
    throw new Error(`Failed to write ${relPath} in sandbox: ${result.stderr || result.stdout}`.trim());
  }
}

interface TemplateFile {
  workspacePath: string;
  content: string;
}

/**
 * Read the template shipped beside the currently executing package module.
 *
 * In development this resolves to `src/sandbox/template`; after `npm run
 * build` it resolves to the template copied beside `dist/sandbox/index.js`.
 * It intentionally does not read `/opt/impulse/template` from the mission
 * container: a resumed volume may be attached to an older image.
 */
async function currentControlPlaneFiles(): Promise<TemplateFile[]> {
  const templateRoot = fileURLToPath(new URL('./template/', import.meta.url));
  const files: TemplateFile[] = [
    {
      workspacePath: '.claude/settings.json',
      content: await fs.readFile(path.join(templateRoot, 'settings.json'), 'utf8'),
    },
  ];

  for (const directory of ['hooks', 'skills']) {
    const sourceRoot = path.join(templateRoot, directory);
    const relativeFiles = await listRegularFiles(sourceRoot);
    for (const relativePath of relativeFiles) {
      files.push({
        workspacePath: path.posix.join('.claude', directory, relativePath.split(path.sep).join(path.posix.sep)),
        content: await fs.readFile(path.join(sourceRoot, relativePath), 'utf8'),
      });
    }
  }

  return files.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}

async function listRegularFiles(root: string, relativeDirectory = ''): Promise<string[]> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported entry in trusted sandbox template: ${path.join(root, relativePath)}`);
    }
  }

  return files;
}

/**
 * Restore the supervisor-owned Claude control plane in an existing workspace.
 *
 * The whole project-local `.claude` tree is replaced, so builder-created
 * settings, agents, commands, hooks, rules, and skills cannot influence a
 * later independent reviewer. Product code, MISSION.md, and `.impulse` phase
 * artifacts are outside this boundary and are never touched. The refreshed
 * tree comes from the current host package, not the sandbox image, which also
 * upgrades reused volumes attached to stale containers.
 */
export async function refreshWorkspaceControlPlane(opts: {
  cfg: BuildConfig;
  missionId: string;
  driver: SandboxDriver;
  ref: SandboxRef;
  artifactKind?: string;
}): Promise<ControlPlaneRefreshResult> {
  const { cfg, missionId, driver, ref } = opts;
  const platformServers = platformServersFor(cfg, opts.artifactKind);
  const templateFiles = await currentControlPlaneFiles();
  await resetWorkspaceGitControlPlane(driver, ref);

  // Template contents were fully read above, before the workspace changes.
  // Remove first so symlinks and builder-added project-local Claude files are
  // discarded rather than followed or merged with the trusted template. A
  // failed driver write aborts the launch; no product or phase path is touched.
  const reset = await driver.exec(ref, [
    'sh',
    '-c',
    'rm -rf -- .claude .mcp.json && mkdir -p -- .claude/hooks .claude/skills',
  ]);
  if (reset.code !== 0) {
    throw new Error(`Failed to reset workspace control plane: ${reset.stderr || reset.stdout}`.trim());
  }

  for (const file of templateFiles) {
    await writeWorkspaceFile(driver, ref, file.workspacePath, file.content);
  }
  await writeWorkspaceFile(driver, ref, '.mcp.json', renderMcpJson(cfg, missionId, platformServers));
  await writeWorkspaceFile(driver, ref, SESSION_ENV_ALLOWLIST_PATH, renderSessionEnvAllowlist(cfg, platformServers));

  const chmod = await driver.exec(ref, ['sh', '-c', "find .claude/hooks -type f -name '*.sh' -exec chmod 0755 {} +"]);
  if (chmod.code !== 0) {
    throw new Error(`Failed to make trusted workspace hooks executable: ${chmod.stderr || chmod.stdout}`.trim());
  }

  // Force-add defeats builder-authored ignore rules. The path-limited diff
  // and --only commit keep any staged product work out of this supervisor
  // checkpoint. Hooks and signing are disabled for this trusted commit so a
  // builder cannot execute code or block it through repository configuration.
  const add = await runTrustedWorkspaceGit(driver, ref, ['add', '--force', '--all', '--', '.claude', '.mcp.json']);
  if (add.code !== 0) {
    throw new Error(`Failed to stage refreshed workspace control plane: ${add.stderr || add.stdout}`.trim());
  }

  const diff = await runTrustedWorkspaceGit(driver, ref, ['diff', '--cached', '--quiet', '--', '.claude', '.mcp.json']);
  if (diff.code === 0) return { changed: false, commit: null };
  if (diff.code !== 1) {
    throw new Error(`Failed to inspect refreshed workspace control plane: ${diff.stderr || diff.stdout}`.trim());
  }

  const commit = await runTrustedWorkspaceGit(driver, ref, [
    'commit',
    '--only',
    '--no-verify',
    '-m',
    CONTROL_PLANE_COMMIT_MESSAGE,
    '--',
    '.claude',
    '.mcp.json',
  ]);
  if (commit.code !== 0) {
    throw new Error(`Failed to commit refreshed workspace control plane: ${commit.stderr || commit.stdout}`.trim());
  }

  const head = await runTrustedWorkspaceGit(driver, ref, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    throw new Error(`Failed to read refreshed workspace control-plane commit: ${head.stderr || head.stdout}`.trim());
  }
  return { changed: true, commit: head.stdout.trim() };
}

/**
 * Replace a persisted mission's runtime without replacing its named volume.
 *
 * Docker configured env and HOME state cannot be made trustworthy with
 * `stop`/`start`: same-UID mission code can read the original values from
 * `/proc/1/environ`. Recreating the container is therefore the security
 * boundary for every reuse and builder-to-reviewer transition. This function
 * only manages the runtime and probes the existing volume; it never writes any
 * workspace file.
 */
export async function recreateSandboxRuntime(opts: {
  cfg: BuildConfig;
  missionId: string;
  driver: SandboxDriver;
  ref: SandboxRef;
  hostPort: number;
  hostEnv?: Record<string, string | undefined>;
  artifactKind?: string;
  /** Agent runtimes receive the configured allowlist; preview runtimes receive no host secrets. */
  purpose?: 'agent' | 'preview';
}): Promise<ProvisionResult> {
  const { cfg, missionId, driver, ref, hostPort } = opts;
  if (missionId !== ref.missionId) {
    throw new Error(`Refusing to recreate mission ${missionId} with runtime owned by ${ref.missionId}`);
  }
  const expectedContainerName = containerNameFor(missionId);
  const expectedVolumeName = volumeNameFor(missionId);
  if (ref.containerName !== expectedContainerName || ref.volumeName !== expectedVolumeName) {
    throw new Error(
      `Refusing to recreate non-canonical runtime identity for ${missionId}: expected ` +
        `${expectedContainerName}/${expectedVolumeName}`
    );
  }
  if (hostPort !== ref.hostPort) {
    throw new Error(
      `Refusing to recreate ${ref.containerName} on host port ${hostPort}; persisted mission port is ${ref.hostPort}`
    );
  }

  const purpose = opts.purpose ?? 'agent';
  const platformServers = purpose === 'preview' ? [] : platformServersFor(cfg, opts.artifactKind);
  const resolved =
    purpose === 'preview'
      ? { env: {} as Record<string, string>, warnings: [] as string[] }
      : resolveContainerEnv(cfg, opts.hostEnv, platformServers);
  const env = resolved.env;
  const warnings: string[] = [...resolved.warnings];
  // BUILD-039: rebind the mission's check-dependency cache so a browser
  // installed before this recreation is still executable after it. Verification
  // runtimes bind read-only — the reviewer executes the browser but cannot
  // rewrite the cache while its own acceptance checks run.
  const browserCacheVolume = browserCacheMountFor(missionId, { readOnly: purpose === 'preview' });
  const createOptions = {
    missionId,
    image: fullImageName(cfg),
    cpus: cfg.cpus,
    memoryGb: cfg.memoryGb,
    pidsLimit: cfg.pidsLimit,
    network: cfg.network,
    hostPort,
    containerPort: cfg.containerPort,
    workspacePath: cfg.workspacePath,
    env,
    browserCacheVolume,
  };

  // The outgoing runtime is the last place the cache is writable before a
  // read-only rebind. Acceptance checks run as `preview` (uid 1001) while the
  // image owns this path as `node` (uid 1000), so widen read/execute here or
  // the surviving cache is unusable to the very user that needs it. Only the
  // browser cache is touched: the workspace stays 0700/node.
  if (purpose === 'preview') {
    try {
      const widened = await driver.exec(ref, ['/bin/chmod', '-R', 'a+rX', '--', browserCacheVolume.mountPath], {
        timeoutMs: 120_000,
        user: 'root',
      });
      if (widened.code !== 0) {
        warnings.push(
          `Could not widen browser-cache read access before read-only rebind: ${(widened.stderr || widened.stdout).trim().slice(-200)}`
        );
      }
    } catch (error) {
      warnings.push(`Could not widen browser-cache read access before read-only rebind: ${errorMessage(error)}`);
    }
  }

  await driver.destroy(ref, { removeVolume: false });

  let recreated: SandboxRef | null = null;
  let lastCreateError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      recreated = await driver.create(createOptions);
      break;
    } catch (error) {
      lastCreateError = error;
      if (attempt < 2) await driver.destroy(ref, { removeVolume: false });
    }
  }
  if (!recreated) {
    await driver.destroy(ref, { removeVolume: false });
    throw new Error(`Failed to recreate sandbox runtime after 2 attempts: ${errorMessage(lastCreateError)}`);
  }

  if (recreated.volumeName !== ref.volumeName) {
    await driver.destroy(recreated, { removeVolume: false });
    throw new Error(
      `Recreated sandbox mounted unexpected volume ${recreated.volumeName}; expected persisted volume ${ref.volumeName}`
    );
  }

  const readyRef = recreated;
  const ready = await waitFor(
    () =>
      driver
        .exec(readyRef, ['sh', '-c', 'test -d .git && test -f MISSION.md && test -f .impulse/STATUS.json'])
        .then((result) => result.code === 0),
    30_000
  );
  if (!ready) {
    await driver.destroy(recreated, { removeVolume: false });
    throw new Error(
      `Recreated sandbox ${recreated.containerName} did not expose the persisted mission workspace within 30s`
    );
  }

  return { ref: recreated, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Create the sandbox, write the mission files, init git. */
export async function provisionSandbox(opts: {
  cfg: BuildConfig;
  missionId: string;
  brief: string;
  driver: SandboxDriver;
  hostEnv?: Record<string, string | undefined>;
  /** Scopes platform-MCP exposure: an 'evaluation' gets none by default. */
  artifactKind?: string;
  /**
   * Optional per-artifact design directive (Task 5) — seeded verbatim as
   * `.impulse/design-brief.json` so the sandbox's visual gate (Task 6) can
   * read the brand tokens. `unknown` deliberately: this package doesn't
   * depend on the app's `DesignBrief` zod schema — the provisioner just
   * serializes whatever it's handed.
   */
  designBrief?: unknown;
  /**
   * BUILD-036: optional bounded, authorized context manifest — serialized
   * verbatim as `.impulse/context-manifest.json` next to MISSION.md (the brief
   * itself already carries the rendered "## Authorized context" section). Typed
   * `unknown` for the same reason as `designBrief`: this package doesn't depend
   * on the app's zod schema — the provisioner just serializes what it's handed.
   */
  contextManifest?: unknown;
}): Promise<ProvisionResult> {
  const { cfg, missionId, brief, driver } = opts;
  const platformServers = platformServersFor(cfg, opts.artifactKind);
  const { env, warnings } = resolveContainerEnv(cfg, opts.hostEnv, platformServers);

  const taken = await driver.usedHostPorts();
  const hostPort = pickHostPort(missionId, cfg.portRangeStart, cfg.portRangeEnd, taken);

  const ref = await driver.create({
    missionId,
    image: fullImageName(cfg),
    cpus: cfg.cpus,
    memoryGb: cfg.memoryGb,
    pidsLimit: cfg.pidsLimit,
    network: cfg.network,
    hostPort,
    containerPort: cfg.containerPort,
    workspacePath: cfg.workspacePath,
    env,
    // BUILD-039: the agent installs its own browser build, so this first
    // runtime binds the cache read-write. Recreation rebinds the same volume.
    browserCacheVolume: browserCacheMountFor(missionId, { readOnly: false }),
  });

  // Wait for the entrypoint to finish seeding the template into the volume.
  const seeded = await waitFor(
    () => driver.exec(ref, ['test', '-f', '.claude/settings.json']).then((r) => r.code === 0),
    30_000
  );
  if (!seeded) {
    throw new Error(
      `Sandbox ${ref.containerName} did not seed its workspace template within 30s — check the image (${fullImageName(cfg)}) entrypoint.`
    );
  }

  await writeWorkspaceFile(driver, ref, 'MISSION.md', brief);
  await writeWorkspaceFile(driver, ref, '.mcp.json', renderMcpJson(cfg, missionId, platformServers));
  await writeWorkspaceFile(driver, ref, SESSION_ENV_ALLOWLIST_PATH, renderSessionEnvAllowlist(cfg, platformServers));
  await writeWorkspaceFile(driver, ref, '.impulse/STATUS.json', JSON.stringify(INITIAL_STATUS, null, 2) + '\n');
  if (opts.designBrief) {
    await writeWorkspaceFile(
      driver,
      ref,
      '.impulse/design-brief.json',
      JSON.stringify(opts.designBrief, null, 2) + '\n'
    );
  }
  if (opts.contextManifest) {
    await writeWorkspaceFile(
      driver,
      ref,
      '.impulse/context-manifest.json',
      JSON.stringify(opts.contextManifest, null, 2) + '\n'
    );
  }

  const git = await driver.exec(ref, [
    'sh',
    '-lc',
    'git init -q && git config user.email mission@radarist.local && git config user.name "Build Mission" && git add -A && git commit -qm "chore: mission workspace seed"',
  ]);
  if (git.code !== 0) {
    throw new Error(`Workspace git init failed: ${git.stderr || git.stdout}`.trim());
  }
  return { ref, warnings };
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
