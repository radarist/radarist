/**
 * The .impulse/STATUS.json contract — the mission's single source of truth
 * for resumability. Written by the agent (mission-methodology skill),
 * read by the supervisor for session planning and by the stop gate.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { runTrustedWorkspaceGit } from './git-control-plane.js';
import type { SandboxDriver, SandboxRef } from './types.js';

export const MISSION_PHASES = [
  '00-inception',
  '01-brainstorm',
  '02-user-flows',
  '03-design-system',
  '04-user-stories',
  '05-architecture',
  '06-build',
  '07-self-test',
  '08-qa',
  'done',
] as const;

export const statusSchema = z.object({
  phase: z.enum(MISSION_PHASES),
  readyForQa: z.boolean().default(false),
  stories: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['todo', 'in-progress', 'done']),
        cuttable: z.boolean().default(false),
      })
    )
    .default([]),
  blocked: z.string().nullable().default(null),
  handoff: z.object({ reason: z.string(), nextObjective: z.string() }).nullable().optional().default(null),
  notes: z.array(z.string()).default([]),
});
export type MissionStatus = z.infer<typeof statusSchema>;

export interface StatusObservation {
  attemptedAt: string;
  health: 'valid' | 'missing' | 'malformed';
  status: MissionStatus | null;
  digest: string | null;
}

export const INITIAL_STATUS: MissionStatus = {
  phase: '00-inception',
  readyForQa: false,
  stories: [],
  blocked: null,
  handoff: null,
  notes: [],
};

const STATUS_PATH = '.impulse/STATUS.json';
const FORCE_STOP_PATH = '.impulse/force-stop';
const QA_REPORT_PATH = '.impulse/qa-report.json';

export interface ReviewerWorkspaceSnapshot {
  version: 1;
  algorithm: 'sha256';
  digest: string;
  entries: number;
  bytes: number;
}

const REVIEWER_WORKSPACE_SNAPSHOT_SCRIPT = String.raw`
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sessionIndex = Number(process.argv[1]);
if (!Number.isSafeInteger(sessionIndex) || sessionIndex < 0) throw new Error('invalid reviewer session index');
const excludedExact = new Set([
  '.impulse/STATUS.json', '.impulse/qa-report.json', '.impulse/.stop-attempts', '.impulse/force-stop',
  '.impulse/session-' + sessionIndex + '.jsonl',
  '.impulse/session-' + sessionIndex + '.stderr.log',
  '.impulse/session-' + sessionIndex + '.exitcode',
  '.impulse/session-' + sessionIndex + '.launch',
]);
const excludedDerivedRoots = [
  '.next', '.nuxt', '.svelte-kit', '.turbo', 'coverage', 'dist',
  'playwright-report', 'test-results',
];
const isDerivedOutput = (relative) => excludedDerivedRoots.some((root) =>
  relative === root || relative.startsWith(root + '/')) ||
  relative === 'node_modules/.cache' || relative.startsWith('node_modules/.cache/');
const isExcluded = (relative) => relative === '.git' || relative.startsWith('.git/') ||
  isDerivedOutput(relative) || excludedExact.has(relative) || relative === '.impulse/qa-screenshots' ||
  relative.startsWith('.impulse/qa-screenshots/');
const root = process.cwd();
const aggregate = crypto.createHash('sha256');
let entries = 0;
let bytes = 0;
const frame = (...values) => {
  for (const value of values) {
    const encoded = Buffer.from(String(value), 'utf8');
    aggregate.update(String(encoded.length));
    aggregate.update(':');
    aggregate.update(encoded);
  }
};
const compareNames = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
async function hashFile(absolute, relative, before) {
  const content = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absolute);
    stream.on('data', (chunk) => content.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const after = await fs.promises.lstat(absolute, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !after.isFile()) {
    throw new Error('workspace changed while fingerprinting: ' + JSON.stringify(relative));
  }
  frame('file', relative, before.mode, before.nlink, before.size, content.digest('hex'));
  entries += 1;
  bytes += Number(before.size);
}
async function walk(relativeDirectory) {
  const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  const names = await fs.promises.readdir(absoluteDirectory);
  names.sort(compareNames);
  for (const name of names) {
    const relative = relativeDirectory ? relativeDirectory + '/' + name : name;
    if (isExcluded(relative)) continue;
    const absolute = path.join(root, relative);
    const stat = await fs.promises.lstat(absolute, { bigint: true });
    if (stat.isDirectory()) {
      frame('directory', relative, stat.mode);
      entries += 1;
      await walk(relative);
    } else if (stat.isFile()) {
      await hashFile(absolute, relative, stat);
    } else if (stat.isSymbolicLink()) {
      frame('symlink', relative, stat.mode, await fs.promises.readlink(absolute));
      entries += 1;
    } else {
      throw new Error('unsupported workspace entry: ' + JSON.stringify(relative));
    }
  }
}
walk('').then(() => process.stdout.write(JSON.stringify({
  version: 1,
  algorithm: 'sha256',
  digest: aggregate.digest('hex'),
  entries,
  bytes,
}))).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
`;

export async function readStatus(driver: SandboxDriver, ref: SandboxRef): Promise<MissionStatus | null> {
  return (await readStatusObservation(driver, ref)).status;
}

/** Read STATUS without collapsing missing and malformed state into one null. */
export async function readStatusObservation(
  driver: SandboxDriver,
  ref: SandboxRef
): Promise<StatusObservation> {
  const attemptedAt = new Date().toISOString();
  const result = await driver.exec(ref, ['cat', STATUS_PATH]);
  if (result.code !== 0) return { attemptedAt, health: 'missing', status: null, digest: null };
  const digest = createHash('sha256').update(result.stdout, 'utf8').digest('hex');
  try {
    return { attemptedAt, health: 'valid', status: statusSchema.parse(JSON.parse(result.stdout)), digest };
  } catch {
    return { attemptedAt, health: 'malformed', status: null, digest };
  }
}

/** Supervisor escape hatch: lets the stop gate release a session being killed at a cap. */
export async function writeForceStop(driver: SandboxDriver, ref: SandboxRef): Promise<void> {
  await driver.exec(ref, ['sh', '-c', `mkdir -p .impulse && touch ${FORCE_STOP_PATH}`]);
}

export async function clearForceStop(driver: SandboxDriver, ref: SandboxRef): Promise<void> {
  await driver.exec(ref, ['rm', '-f', FORCE_STOP_PATH]);
}

export const qaReportSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  checkedAt: z.string(),
  summary: z.string().default(''),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        title: z.string(),
        detail: z.string().default(''),
        story: z.string().optional(),
      })
    )
    .default([]),
  zeroFindingsSuspicious: z.boolean().optional(),
});
export type QaReport = z.infer<typeof qaReportSchema>;

export async function readQaReport(driver: SandboxDriver, ref: SandboxRef): Promise<QaReport | null> {
  const result = await driver.exec(ref, ['cat', QA_REPORT_PATH]);
  if (result.code !== 0) return null;
  try {
    return qaReportSchema.parse(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

/** Preserve a stale verdict for forensics, then clear the live QA slot. */
export async function archiveQaReport(
  driver: SandboxDriver,
  ref: SandboxRef,
  label: string
): Promise<boolean> {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'archived';
  const destination = `.impulse/qa-archive/${safeLabel}.json`;
  const exists = await driver.exec(ref, ['/usr/bin/test', '-f', QA_REPORT_PATH]);
  if (exists.code !== 0) return false;
  const mkdir = await driver.exec(ref, ['/bin/mkdir', '-p', '--', '.impulse/qa-archive']);
  if (mkdir.code !== 0) throw new Error(`Failed to archive QA report: ${mkdir.stderr || mkdir.stdout}`.trim());
  const moved = await driver.exec(ref, ['/bin/mv', '--', QA_REPORT_PATH, destination]);
  if (moved.code !== 0) throw new Error(`Failed to archive QA report: ${moved.stderr || moved.stdout}`.trim());
  return true;
}

/** Builder handoff evidence required before an independent reviewer may run. */
export async function hasQaHandoffEvidence(driver: SandboxDriver, ref: SandboxRef): Promise<boolean> {
  const [report, screenshot] = await Promise.all([
    driver.exec(ref, ['/usr/bin/test', '-f', 'docs/07-test-report.md']),
    driver.exec(ref, ['/usr/bin/find', '.impulse/screenshots', '-type', 'f', '-print', '-quit']),
  ]);
  return report.code === 0 && screenshot.code === 0 && screenshot.stdout.length > 0;
}

/** Current workspace commit, used to prevent a reviewer from changing product code. */
export async function readWorkspaceGitHead(driver: SandboxDriver, ref: SandboxRef): Promise<string | null> {
  const result = await runTrustedWorkspaceGit(driver, ref, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const head = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/i.test(head) ? head : null;
}

/** Content-sensitive snapshot of every reviewer-visible workspace entry. */
export async function captureReviewerWorkspaceSnapshot(
  driver: SandboxDriver,
  ref: SandboxRef,
  sessionIndex: number
): Promise<ReviewerWorkspaceSnapshot | null> {
  if (!Number.isSafeInteger(sessionIndex) || sessionIndex < 0) return null;
  const result = await driver.exec(
    ref,
    [
      '/usr/bin/env',
      '-i',
      'HOME=/nonexistent',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'LANG=C',
      'LC_ALL=C',
      '/usr/local/bin/node',
      '-e',
      REVIEWER_WORKSPACE_SNAPSHOT_SCRIPT,
      String(sessionIndex),
    ],
    { timeoutMs: 180_000 }
  );
  if (result.code !== 0) return null;
  try {
    const value = JSON.parse(result.stdout) as Partial<ReviewerWorkspaceSnapshot>;
    return value.version === 1 &&
      value.algorithm === 'sha256' &&
      typeof value.digest === 'string' &&
      /^[0-9a-f]{64}$/i.test(value.digest) &&
      Number.isSafeInteger(value.entries) &&
      value.entries! >= 0 &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes! >= 0
      ? (value as ReviewerWorkspaceSnapshot)
      : null;
  } catch {
    return null;
  }
}

function splitNulFields(output: string): string[] | null {
  if (output === '') return [];
  if (!output.endsWith('\0')) return null;
  return output.slice(0, -1).split('\0');
}

function parseCommittedChanges(output: string): string[] | null {
  const fields = splitNulFields(output);
  if (!fields) return null;
  const paths: string[] = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++];
    if (!/^[A-Z][0-9]*$/.test(code ?? '')) return null;
    const first = fields[index++];
    if (!first) return null;
    paths.push(first);
    if (/^[RC]/.test(code)) {
      const second = fields[index++];
      if (!second) return null;
      paths.push(second);
    }
  }
  return paths;
}

function parseWorkingChanges(output: string): string[] | null {
  const fields = splitNulFields(output);
  if (!fields) return null;
  const paths: string[] = [];
  for (let index = 0; index < fields.length; ) {
    const entry = fields[index++];
    if (!entry || entry.length < 4 || entry[2] !== ' ') return null;
    const first = entry.slice(3);
    if (!first) return null;
    paths.push(first);
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const second = fields[index++];
      if (!second) return null;
      paths.push(second);
    }
  }
  return paths;
}

/** Committed and uncommitted paths changed since a trusted builder handoff. */
export async function listWorkspaceChangesSince(
  driver: SandboxDriver,
  ref: SandboxRef,
  baseHead: string
): Promise<string[]> {
  if (!/^[0-9a-f]{40}$/i.test(baseHead)) return ['<invalid-base-head>'];
  const [committed, working] = await Promise.all([
    runTrustedWorkspaceGit(driver, ref, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      `${baseHead}..HEAD`,
      '--',
    ]),
    runTrustedWorkspaceGit(driver, ref, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--']),
  ]);
  if (committed.code !== 0 || working.code !== 0) return ['<workspace-integrity-unavailable>'];
  const committedPaths = parseCommittedChanges(committed.stdout);
  const workingPaths = parseWorkingChanges(working.stdout);
  if (!committedPaths || !workingPaths) return ['<workspace-integrity-unavailable>'];
  const paths = new Set([...committedPaths, ...workingPaths]);
  return [...paths].sort();
}

/**
 * Technology-evaluation verdict (.impulse/verdict.json) — written by the
 * eval brief's "Done means" and read back by the supervisor at publish.
 * Tolerant parser: a missing or malformed verdict yields null rather than
 * throwing. The build supervisor decides whether that artifact may publish.
 */
export const verdictSchema = z.object({
  trl: z.number().int().min(1).max(9).optional(),
  confidence: z.number().min(0).max(100).optional(),
  recommendation: z.enum(['adopt', 'trial', 'assess', 'hold']).optional(),
  metrics: z.array(z.object({ name: z.string(), value: z.string(), command: z.string().optional() })).default([]),
  findings: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().default(''),
        kind: z.enum(['verdict', 'benchmark', 'risk', 'observation']).default('observation'),
        metric: z.string().optional(),
        confidence: z.number().min(0).max(100).optional(),
      })
    )
    .default([]),
  summary: z.string().default(''),
});
export type Verdict = z.infer<typeof verdictSchema>;

export async function readVerdict(driver: SandboxDriver, ref: SandboxRef): Promise<Verdict | null> {
  const result = await driver.exec(ref, ['cat', '.impulse/verdict.json']);
  if (result.code !== 0) return null;
  try {
    return verdictSchema.parse(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}
