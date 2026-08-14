/**
 * Verifies that the package version agrees with release-facing docs and UI,
 * and that the public documentation surface is locally link-closed.
 * For release candidates, also rejects a final-release README status or a dated
 * final-version CHANGELOG entry.
 *
 * Public quality gates invoke this directly so release-facing identity cannot drift.
 *
 * Run manually: `npx tsx scripts/check-version-consistency.ts`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

interface Source {
  file: string;
  pattern: RegExp;
  label: string;
}

interface StatusSource {
  file: string;
  pattern: RegExp;
  label: string;
}

export type ReadSource = (file: string) => string;

export interface DocumentationValidationOptions {
  documentationFiles?: readonly string[];
  screenshots?: readonly ScreenshotContract[];
}

export interface ScreenshotContract {
  path: string;
  width: number;
  height: number;
}

export const PUBLIC_SCREENSHOTS: readonly ScreenshotContract[] = [
  { path: 'docs/images/dashboard.png', width: 1920, height: 1080 },
  { path: 'docs/images/graph.png', width: 1920, height: 1080 },
  { path: 'docs/images/login.png', width: 1920, height: 1080 },
  { path: 'docs/images/radar.png', width: 1920, height: 1080 },
  { path: 'docs/images/report.png', width: 1920, height: 1080 },
  { path: 'docs/images/triage-relations.png', width: 1920, height: 1080 },
];

const ROOT = join(__dirname, '..');

function readVersionFromPackageJson(): string {
  const raw = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json#version is missing or not a string');
  }
  return parsed.version;
}

const SOURCES: Source[] = [
  {
    file: 'CHANGELOG.md',
    label: 'CHANGELOG.md current source version',
    pattern: /\*\*Current source version:\*\*\s*`([^`]+)`/,
  },
  {
    file: 'README.md',
    label: 'README.md `**Version:**` banner',
    pattern: /\*\*Version:\*\*\s*`([^`]+)`/,
  },
  {
    file: 'src/components/layout/AppLayoutV2.tsx',
    label: 'AppLayoutV2 prototype chip',
    pattern: /\bv([0-9]+\.[0-9]+) prototype\b/,
  },
  {
    file: 'src/app/login/page.tsx',
    label: 'login page prototype chip',
    pattern: /\bv([0-9]+\.[0-9]+) prototype\b/,
  },
  {
    file: 'src/app/signup/page.tsx',
    label: 'signup page prototype chip',
    pattern: /\bv([0-9]+\.[0-9]+) prototype\b/,
  },
  {
    file: 'SECURITY.md',
    label: 'SECURITY.md Supported versions row',
    pattern: /\|\s*`([^`]+)`\s*\|\s*yes/i,
  },
];

const RC_STATUS_SOURCES: StatusSource[] = [
  {
    file: 'CHANGELOG.md',
    label: 'CHANGELOG.md release status',
    pattern: /^\*\*Release status:\*\*\s*(.+)$/m,
  },
  {
    file: 'SECURITY.md',
    label: 'SECURITY.md release status',
    pattern: /^Radarist `[^`]+` (.+)$/m,
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateReleaseIdentity(expected: string, readSource: ReadSource): string[] {
  const failures: string[] = [];
  const expectedPrototypeLine = expected.startsWith('0.1.') ? '0.1' : expected;

  const validateVersionSource = (source: Source) => {
    const content = readSource(source.file);
    const match = content.match(source.pattern);
    const actual = match ? match[1] : null;
    if (actual === null) {
      failures.push(`${source.label}: pattern not matched in ${source.file}`);
      return;
    }
    const expectedValue = source.label.endsWith('prototype chip') ? expectedPrototypeLine : expected;
    if (actual !== expectedValue) {
      failures.push(`${source.label}: found "${actual}", expected "${expectedValue}"`);
    }
  };

  for (const source of SOURCES) {
    validateVersionSource(source);
  }

  try {
    const lock = JSON.parse(readSource('package-lock.json')) as {
      version?: unknown;
      packages?: Record<string, { version?: unknown }>;
    };
    for (const [label, actual] of [
      ['package-lock.json#version', lock.version],
      ['package-lock.json#packages[""]#version', lock.packages?.['']?.version],
    ] as const) {
      if (actual !== expected) failures.push(`${label}: found "${String(actual)}", expected "${expected}"`);
    }
  } catch (error) {
    failures.push(`package-lock.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rcMatch = expected.match(/^(.*)-rc\.\d+$/);
  if (rcMatch) {
    const readme = readSource('README.md');
    const status = readme.match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1] ?? '';
    const expectedStatusPrefix = `Release candidate \`${expected}\``;
    if (!status.startsWith(expectedStatusPrefix) || !/no final public release is declared/i.test(status)) {
      failures.push(
        `README.md status must identify "${expected}" as a release candidate and state that no final public release is declared`
      );
    }

    for (const source of RC_STATUS_SOURCES) {
      const candidateStatus = readSource(source.file).match(source.pattern)?.[1] ?? '';
      if (!/release candidate/i.test(candidateStatus) || !/no final public release is declared/i.test(candidateStatus)) {
        failures.push(`${source.label} must state release-candidate status and that no final public release is declared`);
      }
    }

    const changelog = readSource('CHANGELOG.md');
    const finalVersion = rcMatch[1];
    const datedFinalHeading = new RegExp(
      `^## \\[${escapeRegExp(finalVersion)}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`,
      'm'
    );
    if (datedFinalHeading.test(changelog)) {
      failures.push(
        `CHANGELOG.md declares final version "${finalVersion}" released while package.json is still "${expected}"`
      );
    }

  } else {
    const statusChecks: Array<[string, string]> = [
      ['README.md status', readSource('README.md').match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1] ?? ''],
      ['CHANGELOG.md release status', readSource('CHANGELOG.md').match(/^\*\*Release status:\*\*\s*(.+)$/m)?.[1] ?? ''],
      ['SECURITY.md release status', readSource('SECURITY.md').match(/^Radarist `[^`]+` (.+)$/m)?.[1] ?? ''],
    ];
    for (const [label, status] of statusChecks) {
      if (!status || /release candidate|no final public release/i.test(status)) {
        failures.push(`${label} must identify a final release without release-candidate language`);
      }
    }

    for (const file of ['src/components/layout/AppLayoutV2.tsx', 'src/app/login/page.tsx', 'src/app/signup/page.tsx']) {
      if (/release candidate/i.test(readSource(file))) failures.push(`${file} must not show release-candidate language`);
    }

    const finalHeading = new RegExp(`^## \\[${escapeRegExp(expected)}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
    if (!finalHeading.test(readSource('CHANGELOG.md'))) {
      failures.push(`CHANGELOG.md must contain a dated final heading for "${expected}"`);
    }
  }

  const changelog = readSource('CHANGELOG.md');
  const unreleasedIndex = changelog.indexOf('## [Unreleased]');
  const firstDatedVersionIndex = changelog.search(/^## \[[^\]]+\]\s+-\s+\d{4}-\d{2}-\d{2}\s*$/m);
  if (unreleasedIndex < 0 || (firstDatedVersionIndex >= 0 && unreleasedIndex > firstDatedVersionIndex)) {
    failures.push('CHANGELOG.md must put [Unreleased] before dated version entries');
  }

  return failures;
}

const DOCUMENT_EXTENSIONS = new Set(['.md', '.html']);
const WALK_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.codex',
  'coverage',
  'node_modules',
  'playwright-report',
  'reports',
  'test-results',
  'tmp',
]);

function documentExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function walkDocumentationFiles(root: string, directory = '.', output: string[] = []): string[] {
  const absolute = resolve(root, directory);
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = directory === '.' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!WALK_EXCLUDED_DIRECTORIES.has(entry.name)) walkDocumentationFiles(root, child, output);
    } else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(documentExtension(child))) {
      output.push(child);
    }
  }
  return output;
}

function declaredPublicDocumentationFiles(root: string): string[] {
  return walkDocumentationFiles(root).sort();
}

function localLinkTargets(source: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /!?\[[^\]]*\]\(([^)\n]+)\)/g,
    /^\s*\[[^\]]+\]:\s*(\S+)/gm,
    /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1].trim();
      const target = raw.startsWith('<') ? raw.slice(1, raw.indexOf('>')) : (raw.split(/\s+/)[0] ?? '');
      if (target) targets.push(target);
    }
  }
  return targets;
}

function localPathFromLink(target: string): string | null {
  if (
    target.startsWith('#') ||
    target.startsWith('/') ||
    /^(?:https?:|mailto:|tel:|data:)/i.test(target)
  ) {
    return null;
  }
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function validatePublicDocumentation(
  root: string,
  options: DocumentationValidationOptions = {}
): string[] {
  const failures: string[] = [];
  const documentationFiles = [...(options.documentationFiles ?? declaredPublicDocumentationFiles(root))].sort();
  const screenshots = options.screenshots ?? PUBLIC_SCREENSHOTS;

  for (const path of documentationFiles) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      failures.push(`${path}: public documentation file is missing`);
      continue;
    }
    const source = readFileSync(absolute, 'utf8');
    for (const target of localLinkTargets(source)) {
      const localPath = localPathFromLink(target);
      if (!localPath) continue;
      const resolved = resolve(dirname(absolute), localPath);
      const fromRoot = relative(root, resolved);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        failures.push(`${path}: local link escapes the repository: ${target}`);
      } else if (!existsSync(resolved)) {
        failures.push(`${path}: local link target is missing: ${target}`);
      }
    }
  }

  for (const screenshot of screenshots) {
    const absolute = resolve(root, screenshot.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      failures.push(`${screenshot.path}: required public screenshot is missing`);
      continue;
    }
    const dimensions = pngDimensions(readFileSync(absolute));
    if (!dimensions) {
      failures.push(`${screenshot.path}: required public screenshot is not a PNG`);
    } else if (dimensions.width !== screenshot.width || dimensions.height !== screenshot.height) {
      failures.push(
        `${screenshot.path}: found ${dimensions.width}x${dimensions.height}, expected ${screenshot.width}x${screenshot.height}`
      );
    }
  }

  return failures.sort();
}

function main(): number {
  const expected = readVersionFromPackageJson();
  const checkPublicDocumentation = process.argv.includes('--public-docs');
  const failures = [
    ...validateReleaseIdentity(expected, (file) => readFileSync(join(ROOT, file), 'utf8')),
    ...(checkPublicDocumentation ? validatePublicDocumentation(ROOT) : []),
  ];

  if (failures.length > 0) {
    console.error(`Release identity mismatch (package.json says "${expected}"):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    return 1;
  }

  console.log(
    checkPublicDocumentation
      ? `Public release identity and documentation are consistent at "${expected}"`
      : `Release identity is consistent at "${expected}"`
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
