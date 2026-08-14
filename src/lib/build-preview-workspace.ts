/** Trusted preview launcher shared by initial publication and later restarts. */

import { posix } from 'node:path';

export const REVIEWED_PREVIEW_WORKSPACE = '/tmp/radarist-reviewed-preview';

/**
 * Reviewed-preview contract manifest (BUILD-034). Written by the builder at
 * the workspace root as ordinary reviewed content, so the accepted-review
 * digest and git control plane cover it like any other source file.
 */
export const REVIEWED_PREVIEW_MANIFEST_BASENAME = 'radarist-preview.json';

const REVIEWED_PREVIEW_MANIFEST_MAX_BYTES = 64 * 1024;

export type ReviewedPreviewMode = 'framework-dev' | 'static';

export interface ReviewedPreviewManifest {
  mode: ReviewedPreviewMode;
  /** Static only — directory served, relative to the workspace root. */
  root?: string;
  /** Static only — file served at `/`, relative to `root`. */
  entry?: string;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertSafeRetainedWorkspacePath(workspacePath: string): string {
  const normalized = posix.normalize(workspacePath);
  if (!posix.isAbsolute(workspacePath)) {
    throw new Error('Refusing to launch preview from a non-absolute retained workspace path');
  }
  if (workspacePath !== normalized || normalized === '/') {
    throw new Error('Refusing to launch preview from an unsafe retained workspace path');
  }
  if (pathsOverlap(normalized, REVIEWED_PREVIEW_WORKSPACE)) {
    throw new Error('Refusing to launch preview from an overlapping retained workspace path');
  }
  return normalized;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PreviewDriver<Ref> {
  exec(
    ref: Ref,
    argv: string[],
    opts?: { timeoutMs?: number; input?: string; user?: 'node' | 'preview' | 'root' }
  ): Promise<ExecResult>;
  execDetached(ref: Ref, argv: string[], opts?: { user?: 'node' | 'preview' | 'root' }): Promise<void>;
}

function commandError(context: string, result: ExecResult): Error {
  return new Error(`${context}: ${result.stderr || result.stdout}`.trim());
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Basenames the reviewed application never needs at preview runtime. */
const STRIPPED_PREVIEW_BASENAMES = ['.impulse', '.claude', '.mcp.json', '.memory', '.npmrc', '.netrc'] as const;

/**
 * Top-level roots excluded from the accepted-review digest and therefore
 * removed before any preview launch. A static preview root may not point at
 * them: their bytes were never reviewed.
 */
const UNREVIEWED_DERIVED_OUTPUT_ROOTS = [
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'coverage',
  'dist',
  'playwright-report',
  'test-results',
] as const;

/** Path segments a static preview may never traverse into. */
const STATIC_PREVIEW_DENIED_SEGMENTS = new Set(['node_modules', '.git', '.impulse']);

function buildSensitiveSurfaceRemovalArgv(): string[] {
  const namePredicates = STRIPPED_PREVIEW_BASENAMES.flatMap((name, index) => [
    ...(index === 0 ? [] : ['-o']),
    '-name',
    name,
  ]);

  return [
    '/usr/bin/find',
    REVIEWED_PREVIEW_WORKSPACE,
    '(',
    '-type',
    'd',
    '-name',
    'node_modules',
    '-prune',
    ')',
    '-o',
    '(',
    ...namePredicates,
    '-o',
    '-name',
    '.env*',
    ')',
    '-exec',
    '/bin/rm',
    '-rf',
    '--',
    '{}',
    '+',
  ];
}

const PREVIEW_SECRET_SCAN_SCRIPT = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const values = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
  throw new Error('invalid forbidden-value input');
}
const needles = [...new Set(values)].map((value) => Buffer.from(value));
const maxNeedle = needles.reduce((max, value) => Math.max(max, value.length), 0);
const directories = [root];
const chunk = Buffer.allocUnsafe(1024 * 1024);
while (directories.length > 0) {
  const directory = directories.pop();
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      directories.push(absolute);
      continue;
    }
    if (!stat.isFile()) continue;
    const fd = fs.openSync(absolute, 'r');
    let carry = Buffer.alloc(0);
    try {
      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const current = carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        if (needles.some((needle) => current.indexOf(needle) !== -1)) {
          process.stderr.write(path.relative(root, absolute) + '\n');
          process.exit(3);
        }
        carry = maxNeedle > 1
          ? Buffer.from(current.subarray(Math.max(0, current.length - maxNeedle + 1)))
          : Buffer.alloc(0);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
`;

/** Fixed scanner argv; forbidden values are supplied only through stdin. */
export function buildPreviewSecretScanArgv(previewRoot = REVIEWED_PREVIEW_WORKSPACE): string[] {
  return ['/usr/local/bin/node', '-e', PREVIEW_SECRET_SCAN_SCRIPT, previewRoot];
}

/**
 * Fixed static file server for `mode: "static"` reviewed previews. Trusted
 * supervisor code: it executes NOTHING from the workspace — it only reads
 * regular files under the validated root and mirrors the launch-time
 * containment rules per request (no dot segments, no node_modules, no
 * symlinks, realpath must stay inside the root). Argv: root, port, entry.
 */
const STATIC_PREVIEW_SERVER_SCRIPT = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = process.argv[1];
const port = Number(process.argv[2]);
const entry = process.argv[3];
if (typeof root !== 'string' || !path.isAbsolute(root)) {
  console.error('preview-static: invalid root argument');
  process.exit(2);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('preview-static: invalid port argument');
  process.exit(2);
}
if (
  typeof entry !== 'string' ||
  entry.length === 0 ||
  entry.split('/').some((segment) => segment.length === 0 || segment.startsWith('.'))
) {
  console.error('preview-static: invalid entry argument');
  process.exit(2);
}
const rootReal = fs.realpathSync(root);
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};
function fail(res, status, body, extraHeaders) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}
const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
    }
    const rawPath = String(req.url || '/').split('?')[0].split('#')[0];
    if (rawPath.length > 4096) return fail(res, 400, 'bad request');
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return fail(res, 400, 'bad request');
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return fail(res, 400, 'bad request');
    const segments = decoded.split('/').filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      return fail(res, 400, 'bad request');
    }
    if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) {
      return fail(res, 404, 'not found');
    }
    let candidate =
      segments.length === 0 ? path.join(rootReal, ...entry.split('/')) : path.join(rootReal, ...segments);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      return fail(res, 404, 'not found');
    }
    if (stat.isSymbolicLink()) return fail(res, 404, 'not found');
    if (stat.isDirectory()) {
      candidate = path.join(candidate, 'index.html');
      try {
        stat = fs.lstatSync(candidate);
      } catch {
        return fail(res, 404, 'not found');
      }
      if (stat.isSymbolicLink()) return fail(res, 404, 'not found');
    }
    if (!stat.isFile()) return fail(res, 404, 'not found');
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return fail(res, 404, 'not found');
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      return fail(res, 404, 'not found');
    }
    const extension = path.extname(candidate).slice(1).toLowerCase();
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extension] || 'application/octet-stream',
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    fail(res, 500, 'internal error');
  }
});
server.on('error', (error) => {
  console.error('preview-static: server error ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  console.log('preview-static: listening ' + boundPort);
});
`;

/** Fixed argv for the trusted static preview server (exported for tests). */
export function buildStaticPreviewServerArgv(rootAbsolute: string, port: number, entry: string): string[] {
  return ['/usr/local/bin/node', '-e', STATIC_PREVIEW_SERVER_SCRIPT, rootAbsolute, String(port), entry];
}

function manifestFieldError(field: 'root' | 'entry', reason: string): Error {
  return new Error(`Refusing to launch preview: reviewed-preview manifest "${field}" ${reason}`);
}

/**
 * Validate one static-contract path. The accepted grammar is deliberately
 * tiny: slash-separated segments of [A-Za-z0-9._-] that never start with a
 * dot. That single rule excludes absolute escapes, `..` traversal, dotfile
 * control planes, and shell-hostile characters in one place, and it matches
 * exactly what the static server will agree to serve later.
 */
function normalizeStaticContractPath(field: 'root' | 'entry', value: unknown, allowWorkspaceDot: boolean): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw manifestFieldError(field, 'must be a non-empty string');
  }
  if (value.length > 1024) {
    throw manifestFieldError(field, 'is too long');
  }
  if (value === '.' && allowWorkspaceDot) return '.';
  if (value.startsWith('/')) {
    throw manifestFieldError(field, 'must be a relative path inside the reviewed workspace');
  }
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment.startsWith('.')) {
      throw manifestFieldError(field, `contains an unsupported path segment ${JSON.stringify(segment)}`);
    }
    if (STATIC_PREVIEW_DENIED_SEGMENTS.has(segment)) {
      throw manifestFieldError(field, `cannot point into a dependency or control tree (${JSON.stringify(segment)})`);
    }
  }
  return segments.join('/');
}

/**
 * Parse and validate a reviewed-preview manifest (BUILD-034). Throws with a
 * precise, operator-facing reason on any deviation from the contract; the
 * caller treats every throw as fail-closed evidence.
 */
export function parseReviewedPreviewManifest(raw: string): ReviewedPreviewManifest {
  if (raw.length > REVIEWED_PREVIEW_MANIFEST_MAX_BYTES) {
    throw new Error(`Refusing to launch preview: ${REVIEWED_PREVIEW_MANIFEST_BASENAME} is too large to review`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Refusing to launch preview: ${REVIEWED_PREVIEW_MANIFEST_BASENAME} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Refusing to launch preview: ${REVIEWED_PREVIEW_MANIFEST_BASENAME} must be a JSON object`);
  }
  const manifest = parsed as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    if (key !== 'mode' && key !== 'root' && key !== 'entry') {
      throw new Error(
        `Refusing to launch preview: reviewed-preview manifest has unsupported key ${JSON.stringify(key)}`
      );
    }
  }
  const mode = manifest.mode;
  if (mode !== 'framework-dev' && mode !== 'static') {
    throw new Error('Refusing to launch preview: reviewed-preview manifest "mode" must be "framework-dev" or "static"');
  }
  if (mode === 'framework-dev') {
    if (manifest.root !== undefined || manifest.entry !== undefined) {
      throw new Error(
        'Refusing to launch preview: reviewed-preview manifest "root"/"entry" only applies to static previews'
      );
    }
    return { mode };
  }
  const root = normalizeStaticContractPath('root', manifest.root ?? '.', true);
  if (root !== '.') {
    const firstSegment = root.split('/')[0];
    if ((UNREVIEWED_DERIVED_OUTPUT_ROOTS as readonly string[]).includes(firstSegment)) {
      throw manifestFieldError(
        'root',
        `cannot point at an unreviewed derived output (${JSON.stringify(firstSegment)})`
      );
    }
  }
  const entry = normalizeStaticContractPath('entry', manifest.entry ?? 'index.html', false);
  return { mode, root, entry };
}

/** Read + validate the workspace's reviewed-preview manifest, if present. */
async function readReviewedPreviewManifest<Ref>(
  driver: PreviewDriver<Ref>,
  ref: Ref
): Promise<ReviewedPreviewManifest | null> {
  const manifestPath = `${REVIEWED_PREVIEW_WORKSPACE}/${REVIEWED_PREVIEW_MANIFEST_BASENAME}`;
  const probed = await driver.exec(
    ref,
    [
      '/usr/bin/find',
      REVIEWED_PREVIEW_WORKSPACE,
      '-maxdepth',
      '1',
      '-name',
      REVIEWED_PREVIEW_MANIFEST_BASENAME,
      '-printf',
      '%y %s\n',
    ],
    { user: 'root' }
  );
  if (probed.code !== 0) throw commandError('Failed to inspect the reviewed-preview manifest', probed);
  const probeLine = probed.stdout.trim();
  if (probeLine === '') return null;
  const probeMatch = /^([a-z]) (\d+)$/.exec(probeLine);
  if (!probeMatch || probeMatch[1] !== 'f') {
    throw new Error(`Refusing to launch preview: ${REVIEWED_PREVIEW_MANIFEST_BASENAME} must be a regular file`);
  }
  if (Number(probeMatch[2]) > REVIEWED_PREVIEW_MANIFEST_MAX_BYTES) {
    throw new Error(`Refusing to launch preview: ${REVIEWED_PREVIEW_MANIFEST_BASENAME} is too large to review`);
  }
  const read = await driver.exec(ref, ['/bin/cat', '--', manifestPath], { user: 'root' });
  if (read.code !== 0) throw commandError('Failed to read the reviewed-preview manifest', read);
  return parseReviewedPreviewManifest(read.stdout);
}

/** Validate framework-dev preconditions so failures carry precise evidence. */
async function assertFrameworkDevPreconditions<Ref>(driver: PreviewDriver<Ref>, ref: Ref): Promise<void> {
  const packageJsonPath = `${REVIEWED_PREVIEW_WORKSPACE}/package.json`;
  const probed = await driver.exec(
    ref,
    ['/usr/bin/find', packageJsonPath, '-maxdepth', '0', '-type', 'f', '-printf', 'f'],
    { user: 'root' }
  );
  if (probed.code !== 0 || probed.stdout.trim() !== 'f') {
    throw new Error(
      'Refusing to launch preview: framework-dev preview requires a regular package.json at the workspace root'
    );
  }
  const read = await driver.exec(ref, ['/bin/cat', '--', packageJsonPath], { user: 'root' });
  if (read.code !== 0) throw commandError('Failed to read the reviewed package.json', read);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.stdout);
  } catch {
    throw new Error('Refusing to launch preview: the reviewed package.json is not valid JSON');
  }
  const scripts =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  const dev =
    scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>).dev
      : undefined;
  if (typeof dev !== 'string' || dev.trim().length === 0) {
    throw new Error(
      'Refusing to launch preview: framework-dev preview requires a non-empty "scripts.dev" entry in package.json'
    );
  }
}

/** Validate static-contract targets against the actual reviewed bytes. */
async function assertStaticPreviewTargets<Ref>(
  driver: PreviewDriver<Ref>,
  ref: Ref,
  manifest: ReviewedPreviewManifest
): Promise<{ rootAbsolute: string; entry: string }> {
  const root = manifest.root ?? '.';
  const entry = manifest.entry ?? 'index.html';
  const rootAbsolute = root === '.' ? REVIEWED_PREVIEW_WORKSPACE : `${REVIEWED_PREVIEW_WORKSPACE}/${root}`;
  const entryAbsolute = `${rootAbsolute}/${entry}`;
  const entryDisplay = root === '.' ? entry : `${root}/${entry}`;

  const rootProbe = await driver.exec(
    ref,
    ['/usr/bin/find', rootAbsolute, '-maxdepth', '0', '-type', 'd', '-printf', 'd'],
    { user: 'root' }
  );
  if (rootProbe.code !== 0 || rootProbe.stdout.trim() !== 'd') {
    throw new Error(
      `Refusing to launch preview: static preview root ${JSON.stringify(root)} was not found in the reviewed output`
    );
  }
  const entryProbe = await driver.exec(
    ref,
    ['/usr/bin/find', entryAbsolute, '-maxdepth', '0', '-type', 'f', '-printf', 'f'],
    { user: 'root' }
  );
  if (entryProbe.code !== 0 || entryProbe.stdout.trim() !== 'f') {
    throw new Error(
      `Refusing to launch preview: static preview entry ${JSON.stringify(entryDisplay)} was not found — ` +
        'the mission produced no reviewable static output at that path'
    );
  }
  for (const [label, absolute] of [
    ['root', rootAbsolute],
    ['entry', entryAbsolute],
  ] as const) {
    const resolved = await driver.exec(ref, ['/usr/bin/realpath', '-e', '--', absolute], { user: 'root' });
    if (resolved.code !== 0) {
      throw commandError(`Failed to resolve the static preview ${label}`, resolved);
    }
    if (resolved.stdout.trim() !== absolute) {
      throw new Error(
        `Refusing to launch preview: static preview ${label} escapes the reviewed workspace ` +
          `(${absolute} resolves to ${resolved.stdout.trim()})`
      );
    }
  }
  // Serve rules already refuse dot segments and node_modules, so symlinks are
  // only fatal where a request could actually reach them.
  const symlinkScan = await driver.exec(
    ref,
    [
      '/usr/bin/find',
      rootAbsolute,
      '(',
      '-type',
      'd',
      '(',
      '-name',
      'node_modules',
      '-o',
      '-name',
      '.*',
      ')',
      '-prune',
      ')',
      '-o',
      '(',
      '-type',
      'l',
      '!',
      '-name',
      '.*',
      '-print',
      ')',
    ],
    { user: 'root' }
  );
  if (symlinkScan.code !== 0) {
    throw commandError('Failed to scan the static preview root for symlinks', symlinkScan);
  }
  const symlinks = symlinkScan.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (symlinks.length > 0) {
    throw new Error(
      `Refusing to launch preview: static preview root contains symlinks (${symlinks.slice(0, 5).join(', ')})`
    );
  }
  return { rootAbsolute, entry };
}

/**
 * Copy the accepted volume state into the disposable container layer, remove
 * every control/config/credential surface outside dependency trees, and launch
 * the reviewed preview. Static mode executes no builder-supplied command;
 * framework-dev intentionally executes the reviewed package's `scripts.dev`
 * through the fixed historical npm argv with lifecycle hooks disabled.
 *
 * Reviewed-preview contract (BUILD-034): an optional `radarist-preview.json`
 * at the workspace root selects one of exactly two trusted launch shapes —
 * `framework-dev` (the historical `npm --ignore-scripts run dev`) or `static`
 * (a fixed, workspace-code-free file server). A missing manifest keeps the
 * legacy framework-dev launch so previously published artifacts restart
 * unchanged. The manifest never contributes a command — only a mode plus two
 * containment-validated relative paths.
 */
export async function launchReviewedPreview<Ref>(opts: {
  driver: PreviewDriver<Ref>;
  ref: Ref;
  buildSanitizedShellCommand: (command: string) => string;
  retainedWorkspacePath: string;
  /** Container-side port the preview must listen on (trusted config). */
  containerPort: number;
  /** Exact values previously authorized inside the agent runtime. */
  forbiddenValues?: string[];
}): Promise<void> {
  const { driver, ref, buildSanitizedShellCommand } = opts;
  const retainedWorkspacePath = assertSafeRetainedWorkspacePath(opts.retainedWorkspacePath);
  if (!Number.isInteger(opts.containerPort) || opts.containerPort < 1 || opts.containerPort > 65_535) {
    throw new Error('Refusing to launch preview with an invalid container port');
  }

  // The preview container still retains the original named volume for future
  // iteration/restart. Make it inaccessible to the distinct preview identity
  // before any application process launches; node remains its owner.
  const isolated = await driver.exec(ref, ['/bin/chown', 'node:node', '--', retainedWorkspacePath], { user: 'root' });
  if (isolated.code !== 0) throw commandError('Failed to isolate retained agent workspace ownership', isolated);
  const locked = await driver.exec(ref, ['/bin/chmod', '0700', '--', retainedWorkspacePath], {
    user: 'root',
  });
  if (locked.code !== 0) throw commandError('Failed to isolate retained agent workspace permissions', locked);

  const cleared = await driver.exec(ref, ['/bin/rm', '-rf', '--', REVIEWED_PREVIEW_WORKSPACE], {
    user: 'root',
  });
  if (cleared.code !== 0) throw commandError('Failed to clear prior reviewed preview workspace', cleared);

  const copied = await driver.exec(
    ref,
    ['/bin/cp', '-a', '--', `${retainedWorkspacePath}/.`, REVIEWED_PREVIEW_WORKSPACE],
    { timeoutMs: 120_000, user: 'root' }
  );
  if (copied.code !== 0) throw commandError('Failed to prepare reviewed preview workspace', copied);

  const removedSensitiveSurfaces = await driver.exec(ref, buildSensitiveSurfaceRemovalArgv(), {
    user: 'root',
  });
  if (removedSensitiveSurfaces.code !== 0) {
    throw commandError('Failed to strip sensitive preview surfaces', removedSensitiveSurfaces);
  }

  // These roots are intentionally excluded from the accepted-review digest,
  // so they cannot be allowed to influence the served preview.
  const removedDerivedOutputs = await driver.exec(
    ref,
    [
      '/bin/rm',
      '-rf',
      '--',
      ...[...UNREVIEWED_DERIVED_OUTPUT_ROOTS, 'node_modules/.cache'].map(
        (path) => `${REVIEWED_PREVIEW_WORKSPACE}/${path}`
      ),
    ],
    { user: 'root' }
  );
  if (removedDerivedOutputs.code !== 0) {
    throw commandError('Failed to remove unreviewed derived preview outputs', removedDerivedOutputs);
  }

  // Resolve the reviewed-preview contract from the exact bytes that will be
  // served (post-copy, post-strip), while the tree is still root-owned and no
  // workspace-authored process can race the validation.
  const manifest = await readReviewedPreviewManifest(driver, ref);
  const mode: ReviewedPreviewMode = manifest?.mode ?? 'framework-dev';
  let staticTarget: { rootAbsolute: string; entry: string } | null = null;
  if (manifest && mode === 'framework-dev') {
    // Explicit contract: validate the npm manifest up front so a broken one
    // fails with evidence instead of a silent readiness timeout. The
    // manifest-less legacy path deliberately skips this to stay byte-identical
    // for artifacts published before the contract existed.
    await assertFrameworkDevPreconditions(driver, ref);
  } else if (mode === 'static') {
    staticTarget = await assertStaticPreviewTargets(driver, ref, manifest!);
  }

  const forbiddenValues = [...new Set((opts.forbiddenValues ?? []).filter((value) => value.length > 0))];
  if (forbiddenValues.length > 0) {
    const scanned = await driver.exec(ref, buildPreviewSecretScanArgv(), {
      timeoutMs: 180_000,
      input: JSON.stringify(forbiddenValues),
      user: 'root',
    });
    if (scanned.code !== 0) {
      throw commandError('Refusing to launch preview containing an authorized secret value', scanned);
    }
  }

  if (mode === 'static') {
    // Static previews execute no workspace code, so the reviewed bytes can
    // stay root-owned and read-only: not even the preview identity can mutate
    // what was reviewed.
    const owned = await driver.exec(ref, ['/bin/chown', '-R', 'root:root', '--', REVIEWED_PREVIEW_WORKSPACE], {
      timeoutMs: 120_000,
      user: 'root',
    });
    if (owned.code !== 0) throw commandError('Failed to lock reviewed static preview ownership', owned);
    const readOnly = await driver.exec(ref, ['/bin/chmod', '-R', 'u=rwX,go=rX', '--', REVIEWED_PREVIEW_WORKSPACE], {
      timeoutMs: 120_000,
      user: 'root',
    });
    if (readOnly.code !== 0) throw commandError('Failed to lock reviewed static preview permissions', readOnly);

    const { rootAbsolute, entry } = staticTarget!;
    const serverArgv = buildStaticPreviewServerArgv(rootAbsolute, opts.containerPort, entry);
    const command =
      `cd ${REVIEWED_PREVIEW_WORKSPACE} && exec ${serverArgv[0]} -e ${shellQuote(serverArgv[2])} ` +
      `${shellQuote(serverArgv[3])} ${shellQuote(serverArgv[4])} ${shellQuote(serverArgv[5])} ` +
      '>/tmp/preview.log 2>&1';
    await driver.execDetached(ref, ['/bin/sh', '-c', buildSanitizedShellCommand(command)], {
      user: 'preview',
    });
    return;
  }

  const assigned = await driver.exec(ref, ['/bin/chown', '-R', 'preview:preview', '--', REVIEWED_PREVIEW_WORKSPACE], {
    timeoutMs: 120_000,
    user: 'root',
  });
  if (assigned.code !== 0) throw commandError('Failed to assign reviewed preview identity', assigned);

  await driver.execDetached(
    ref,
    [
      '/bin/sh',
      '-c',
      buildSanitizedShellCommand(
        `cd ${REVIEWED_PREVIEW_WORKSPACE} && exec /usr/local/bin/npm --ignore-scripts run dev >/tmp/preview.log 2>&1`
      ),
    ],
    { user: 'preview' }
  );
}
