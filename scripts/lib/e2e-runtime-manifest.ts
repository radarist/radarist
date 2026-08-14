import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ts from 'typescript';

const LANE_STATUSES = ['active', 'manual'] as const;
export type E2ELaneStatus = (typeof LANE_STATUSES)[number];
const FIREBASE_CONTRACTS = [
  'caller-owned-auth-firestore-seeded',
  'none',
  'operator-selected',
  'owned-auth-firestore',
  'owned-auth-firestore-seeded',
  'owned-auth-firestore-storage',
  'owned-auth-firestore-storage-showcase',
  'owned-dual-user-auth-firestore',
  'owned-dynamic',
  'owned-empty-auth-firestore',
] as const;
const NEO4J_CONTRACTS = [
  'caller-owned-disposable',
  'disabled',
  'none',
  'operator-selected',
  'owned-disposable',
  'stubbed-api',
] as const;
const INNGEST_CONTRACTS = [
  'caller-owned-local',
  'disabled',
  'none',
  'not-required',
  'operator-selected',
  'owned-disposable',
] as const;
const PROVIDER_CONTRACTS = [
  'disabled',
  'live-explicit',
  'loopback-stub',
  'none',
  'not-invoked',
  'not-invoked-caller-owned',
] as const;
// These values describe requests made by audited Playwright browser contexts.
// They make no claim about arbitrary server-side subprocess egress.
// `browser-operator-selected` covers a lane that attaches to whatever backend
// the operator already had running: the browser reaches their live Firebase
// project, but no AI provider is invoked. Claiming `browser-provider-only`
// there would overstate provider contact, and `browser-loopback-only` would be
// plainly false — neither is an honest description, so it gets its own value.
const EXTERNAL_NETWORK_CONTRACTS = [
  'browser-forbidden',
  'browser-loopback-only',
  'browser-operator-selected',
  'browser-provider-only',
] as const;
const CLEANUP_CONTRACTS = [
  'caller-owned-runtime',
  'emulator-process',
  'none',
  'owned-prefix',
  'owned-runtime',
] as const;

type FirebaseRuntimeContract = (typeof FIREBASE_CONTRACTS)[number];
type Neo4jRuntimeContract = (typeof NEO4J_CONTRACTS)[number];
type InngestRuntimeContract = (typeof INNGEST_CONTRACTS)[number];
type ProviderRuntimeContract = (typeof PROVIDER_CONTRACTS)[number];
type ExternalNetworkRuntimeContract = (typeof EXTERNAL_NETWORK_CONTRACTS)[number];
type CleanupRuntimeContract = (typeof CLEANUP_CONTRACTS)[number];

export interface E2ERuntimeContract {
  readonly firebase: FirebaseRuntimeContract;
  readonly neo4j: Neo4jRuntimeContract;
  readonly inngest: InngestRuntimeContract;
  readonly provider: ProviderRuntimeContract;
  readonly externalNetwork: ExternalNetworkRuntimeContract;
  readonly cleanup: CleanupRuntimeContract;
}

export interface E2ELaneContract {
  readonly id: string;
  readonly status: E2ELaneStatus;
  readonly command: string;
  readonly config: string;
  readonly discoveryGrep?: string;
  readonly contract: E2ERuntimeContract;
  readonly specs: readonly string[];
}

export interface E2ERetiredSpecContract {
  readonly path: string;
  readonly reason: string;
  readonly resolution: 'covered' | 'partially-covered' | 'invalid-claim';
  readonly replacements: readonly string[];
}

export interface E2EAssertionReviewContract {
  readonly path: string;
  readonly title: string;
  readonly reason: string;
}

export interface E2ERuntimeManifest {
  readonly schemaVersion: 3;
  readonly ratchets: {
    readonly directCatchFalseMax: number;
    readonly fixedWaitMax: number;
    readonly discoveryMinByLane: Readonly<Record<string, number>>;
  };
  readonly lanes: readonly E2ELaneContract[];
  readonly retiredSpecs: readonly E2ERetiredSpecContract[];
  readonly assertionReviews: readonly E2EAssertionReviewContract[];
}

export const E2E_RUNTIME_MANIFEST_PATH = 'tests/e2e/runtime-manifest.json';

export const PUBLIC_E2E_DISCOVERY_MIN_BY_LANE = Object.freeze({
  generic: 46,
  accessibility: 9,
  'local-smoke': 3,
  'report-publication': 11,
});

export const PUBLIC_E2E_LANE_CONTRACTS = [
  {
    id: 'generic',
    status: 'active',
    command: 'e2e',
    config: 'playwright.config.ts',
    contract: {
      firebase: 'owned-auth-firestore-storage-showcase',
      neo4j: 'disabled',
      inngest: 'disabled',
      provider: 'disabled',
      externalNetwork: 'browser-forbidden',
      cleanup: 'emulator-process',
    },
    specs: [
      'tests/e2e/audit-harness-failsafe.spec.ts',
      'tests/e2e/redirect-integrity.spec.ts',
      'tests/e2e/report-preview-security.spec.ts',
      'tests/e2e/route-integrity.spec.ts',
      'tests/e2e/smoke.test.ts',
    ],
  },
  {
    id: 'accessibility',
    status: 'active',
    command: 'e2e:accessibility',
    config: 'playwright.config.ts',
    contract: {
      firebase: 'owned-auth-firestore-storage-showcase',
      neo4j: 'disabled',
      inngest: 'disabled',
      provider: 'disabled',
      externalNetwork: 'browser-forbidden',
      cleanup: 'emulator-process',
    },
    specs: ['tests/e2e/accessibility-sweep.spec.ts'],
  },
  {
    id: 'local-smoke',
    status: 'manual',
    command: 'e2e:local',
    config: 'playwright.config.ts',
    contract: {
      firebase: 'operator-selected',
      neo4j: 'operator-selected',
      inngest: 'operator-selected',
      provider: 'not-invoked-caller-owned',
      externalNetwork: 'browser-loopback-only',
      cleanup: 'none',
    },
    specs: ['tests/e2e/local-smoke.spec.ts'],
  },
  {
    id: 'report-publication',
    status: 'active',
    command: 'e2e:report-publication',
    config: 'playwright.config.ts',
    contract: {
      firebase: 'none',
      neo4j: 'none',
      inngest: 'none',
      provider: 'none',
      externalNetwork: 'browser-forbidden',
      cleanup: 'none',
    },
    specs: ['tests/e2e/report-publication-conformance.spec.ts'],
  },
] as const satisfies readonly E2ELaneContract[];

const PUBLIC_E2E_LANE_IDS = PUBLIC_E2E_LANE_CONTRACTS.map((lane) => lane.id);
const V3_RATCHET_KEYS = ['directCatchFalseMax', 'fixedWaitMax', 'discoveryMinByLane'] as const;
type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function requireExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      unknown.length > 0 ? `unknown ${unknown.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(`${path} has invalid fields: ${details.join('; ')}`);
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireEnum<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a finite nonnegative integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const result = requireNonNegativeInteger(value, path);
  if (result === 0) throw new Error(`${path} must be a positive integer`);
  return result;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const result = value.map((entry, index) => requireNonEmptyString(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${path} must not contain duplicates`);
  return result;
}

function parseRuntimeContract(value: unknown, path: string): E2ERuntimeContract {
  const record = requireRecord(value, path);
  requireExactKeys(record, ['firebase', 'neo4j', 'inngest', 'provider', 'externalNetwork', 'cleanup'], [], path);
  return {
    firebase: requireEnum(record.firebase, FIREBASE_CONTRACTS, `${path}.firebase`),
    neo4j: requireEnum(record.neo4j, NEO4J_CONTRACTS, `${path}.neo4j`),
    inngest: requireEnum(record.inngest, INNGEST_CONTRACTS, `${path}.inngest`),
    provider: requireEnum(record.provider, PROVIDER_CONTRACTS, `${path}.provider`),
    externalNetwork: requireEnum(record.externalNetwork, EXTERNAL_NETWORK_CONTRACTS, `${path}.externalNetwork`),
    cleanup: requireEnum(record.cleanup, CLEANUP_CONTRACTS, `${path}.cleanup`),
  };
}

function parseLane(value: unknown, index: number): E2ELaneContract {
  const path = `manifest.lanes[${index}]`;
  const record = requireRecord(value, path);
  requireExactKeys(record, ['id', 'status', 'command', 'config', 'contract', 'specs'], ['discoveryGrep'], path);
  const specs = requireStringArray(record.specs, `${path}.specs`);
  if (specs.length === 0) throw new Error(`${path}.specs must not be empty`);
  return {
    id: requireNonEmptyString(record.id, `${path}.id`),
    status: requireEnum(record.status, LANE_STATUSES, `${path}.status`),
    command: requireNonEmptyString(record.command, `${path}.command`),
    config: requireNonEmptyString(record.config, `${path}.config`),
    ...(record.discoveryGrep === undefined
      ? {}
      : { discoveryGrep: requireNonEmptyString(record.discoveryGrep, `${path}.discoveryGrep`) }),
    contract: parseRuntimeContract(record.contract, `${path}.contract`),
    specs,
  };
}

function parseRetiredSpec(value: unknown, index: number): E2ERetiredSpecContract {
  const path = `manifest.retiredSpecs[${index}]`;
  const record = requireRecord(value, path);
  requireExactKeys(record, ['path', 'reason', 'resolution', 'replacements'], [], path);
  const replacements = requireStringArray(record.replacements, `${path}.replacements`);
  const resolution = requireEnum(
    record.resolution,
    ['covered', 'partially-covered', 'invalid-claim'] as const,
    `${path}.resolution`
  );
  if (resolution !== 'invalid-claim' && replacements.length === 0) {
    throw new Error(`${path}.replacements must not be empty when resolution is ${resolution}`);
  }
  return {
    path: requireNonEmptyString(record.path, `${path}.path`),
    reason: requireNonEmptyString(record.reason, `${path}.reason`),
    resolution,
    replacements,
  };
}

function parseAssertionReview(value: unknown, index: number): E2EAssertionReviewContract {
  const path = `manifest.assertionReviews[${index}]`;
  const record = requireRecord(value, path);
  requireExactKeys(record, ['path', 'title', 'reason'], [], path);
  return {
    path: requireNonEmptyString(record.path, `${path}.path`),
    title: requireNonEmptyString(record.title, `${path}.title`),
    reason: requireNonEmptyString(record.reason, `${path}.reason`),
  };
}

function parseManifestCollections(record: JsonRecord): Pick<
  E2ERuntimeManifest,
  'lanes' | 'retiredSpecs' | 'assertionReviews'
> {
  if (!Array.isArray(record.lanes) || record.lanes.length === 0) {
    throw new Error('manifest.lanes must be a non-empty array');
  }
  const lanes = record.lanes.map(parseLane);
  const laneIds = lanes.map((lane) => lane.id);
  if (new Set(laneIds).size !== laneIds.length) throw new Error('manifest lane ids must be unique');
  if (!laneIds.includes('generic')) throw new Error('manifest requires one explicit generic lane');

  const explicitSpecs = new Set<string>();
  for (const lane of lanes) {
    for (const spec of lane.specs) {
      if (explicitSpecs.has(spec)) throw new Error(`manifest spec ${spec} has more than one owner`);
      explicitSpecs.add(spec);
    }
  }

  if (!Array.isArray(record.retiredSpecs)) {
    throw new Error('manifest.retiredSpecs must be an array');
  }
  const retiredSpecs = record.retiredSpecs.map(parseRetiredSpec);
  const retiredPaths = retiredSpecs.map((entry) => entry.path);
  if (new Set(retiredPaths).size !== retiredPaths.length) {
    throw new Error('manifest retired spec paths must be unique');
  }
  for (const retired of retiredSpecs) {
    if (explicitSpecs.has(retired.path)) {
      throw new Error(`retired spec ${retired.path} cannot have an active runtime owner`);
    }
  }

  if (!Array.isArray(record.assertionReviews)) {
    throw new Error('manifest.assertionReviews must be an array');
  }
  const assertionReviews = record.assertionReviews.map(parseAssertionReview);
  const reviewKeys = assertionReviews.map((review) => `${review.path}\0${review.title}`);
  if (new Set(reviewKeys).size !== reviewKeys.length) {
    throw new Error('manifest assertion review path/title pairs must be unique');
  }

  return { lanes, retiredSpecs, assertionReviews };
}

function validateExactPublicLaneContracts(lanes: readonly E2ELaneContract[]): void {
  if (JSON.stringify(lanes) !== JSON.stringify(PUBLIC_E2E_LANE_CONTRACTS)) {
    throw new Error(
      `manifest public lane contracts must exactly match: ${PUBLIC_E2E_LANE_IDS.join(', ')}`
    );
  }
}

/**
 * Parse the public runtime contract without trusting a TypeScript assertion.
 * Schema v3 intentionally has no compatibility path: publication gates must
 * reject the source-tree v2 bytes instead of silently weakening them.
 */
export function parseE2ERuntimeManifest(value: unknown): E2ERuntimeManifest {
  const record = requireRecord(value, 'manifest');
  requireExactKeys(record, ['schemaVersion', 'ratchets', 'lanes', 'retiredSpecs', 'assertionReviews'], [], 'manifest');
  if (record.schemaVersion !== 3) throw new Error('manifest.schemaVersion must be 3');

  const collections = parseManifestCollections(record);
  validateExactPublicLaneContracts(collections.lanes);
  if (collections.retiredSpecs.length > 0) {
    throw new Error('manifest.retiredSpecs must be empty in the public runtime contract');
  }

  const ratchetRecord = requireRecord(record.ratchets, 'manifest.ratchets');
  requireExactKeys(ratchetRecord, V3_RATCHET_KEYS, [], 'manifest.ratchets');
  const directCatchFalseMax = requireNonNegativeInteger(
    ratchetRecord.directCatchFalseMax,
    'manifest.ratchets.directCatchFalseMax'
  );
  const fixedWaitMax = requireNonNegativeInteger(ratchetRecord.fixedWaitMax, 'manifest.ratchets.fixedWaitMax');
  if (directCatchFalseMax !== 0 || fixedWaitMax !== 0) {
    throw new Error('manifest public soft-pass ceilings must both be zero');
  }

  const discoveryRecord = requireRecord(ratchetRecord.discoveryMinByLane, 'manifest.ratchets.discoveryMinByLane');
  requireExactKeys(discoveryRecord, PUBLIC_E2E_LANE_IDS, [], 'manifest.ratchets.discoveryMinByLane');
  const discoveryMinByLane = Object.fromEntries(
    PUBLIC_E2E_LANE_IDS.map((laneId) => [
      laneId,
      requirePositiveInteger(discoveryRecord[laneId], `manifest.ratchets.discoveryMinByLane.${laneId}`),
    ])
  );
  if (JSON.stringify(discoveryMinByLane) !== JSON.stringify(PUBLIC_E2E_DISCOVERY_MIN_BY_LANE)) {
    throw new Error('manifest public discovery floors do not match the retained-lane contract');
  }

  return {
    schemaVersion: 3,
    ratchets: { directCatchFalseMax, fixedWaitMax, discoveryMinByLane },
    ...collections,
  };
}

function loadManifestWith(
  root: string,
  parser: (value: unknown) => E2ERuntimeManifest
): E2ERuntimeManifest {
  const path = resolve(root, E2E_RUNTIME_MANIFEST_PATH);
  try {
    return parser(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid E2E runtime manifest at ${path}: ${detail}`, { cause: error });
  }
}

/** Load only the publication-safe schema. This loader never accepts v2. */
export function loadPublicE2ERuntimeManifest(root = process.cwd()): E2ERuntimeManifest {
  return loadManifestWith(root, parseE2ERuntimeManifest);
}

/**
 * Runtime dependencies an automated lane supervisor cannot safely provision,
 * and which therefore justify manual status. A disposable local graph is
 * provisionable and is deliberately not accepted as a manual-only reason.
 */
export function unprovisionableRuntimeDependencies(contract: E2ERuntimeContract): string[] {
  const reasons: string[] = [];
  if (contract.provider === 'live-explicit') reasons.push('provider=live-explicit');
  for (const [name, value] of [
    ['firebase', contract.firebase],
    ['neo4j', contract.neo4j],
    ['inngest', contract.inngest],
  ] as const) {
    if (value === 'operator-selected' || (value.startsWith('caller-owned') && value !== 'caller-owned-disposable')) {
      reasons.push(`${name}=${value}`);
    }
  }
  return reasons;
}

export function laneById(manifest: E2ERuntimeManifest, laneId: string): E2ELaneContract {
  const matches = manifest.lanes.filter((lane) => lane.id === laneId);
  if (matches.length !== 1) {
    throw new Error(`Expected one E2E lane named ${laneId}, found ${matches.length}`);
  }
  return matches[0];
}

export function explicitSpecLaneMap(manifest: E2ERuntimeManifest): Map<string, string> {
  const result = new Map<string, string>();
  for (const lane of manifest.lanes) {
    for (const spec of lane.specs) {
      const previous = result.get(spec);
      if (previous) throw new Error(`E2E spec ${spec} belongs to both ${previous} and ${lane.id}`);
      result.set(spec, lane.id);
    }
  }
  return result;
}

export function resolveSpecLane(manifest: E2ERuntimeManifest, spec: string): string {
  const lane = explicitSpecLaneMap(manifest).get(spec);
  if (!lane) throw new Error(`E2E spec ${spec} has no explicit runtime owner`);
  return lane;
}

export function laneSpecPatterns(manifest: E2ERuntimeManifest, laneId: string): string[] {
  return laneById(manifest, laneId).specs.map((spec) => `**/${spec.replace(/^tests\/e2e\//, '')}`);
}

/**
 * Select one exact spec from a manifest-owned lane. This is useful for
 * multi-project configs that need to split a lane without re-declaring spec
 * paths as regexes that can silently drift from the manifest.
 */
export function exactLaneSpecPattern(manifest: E2ERuntimeManifest, laneId: string, spec: string): string {
  const lane = laneById(manifest, laneId);
  if (!lane.specs.includes(spec)) {
    throw new Error(`E2E spec ${spec} is not owned by lane ${laneId}`);
  }
  return `**/${spec.replace(/^tests\/e2e\//, '')}`;
}

export function nonGenericSpecPatterns(manifest: E2ERuntimeManifest): string[] {
  return manifest.lanes
    .filter((lane) => lane.id !== 'generic')
    .flatMap((lane) => lane.specs)
    .map((spec) => `**/${spec.replace(/^tests\/e2e\//, '')}`);
}

/**
 * Return exact ignore patterns for every explicitly-owned lane except the one
 * currently being selected through the shared Playwright configuration.
 */
export function specsOutsideLanePatterns(manifest: E2ERuntimeManifest, laneId: string): string[] {
  laneById(manifest, laneId);
  return manifest.lanes
    .filter((lane) => lane.id !== 'generic' && lane.id !== laneId)
    .flatMap((lane) => lane.specs)
    .map((spec) => `**/${spec.replace(/^tests\/e2e\//, '')}`);
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export function discoverE2ESpecs(root = process.cwd()): string[] {
  const testRoot = resolve(root, 'tests/e2e');
  return walk(testRoot)
    .filter((path) => /\.(?:spec|test)\.ts$/.test(path))
    .map((path) => relative(root, path).split(sep).join('/'))
    .sort();
}

/** Every executable TypeScript support/spec file under the browser-test tree. */
export function discoverE2ETypeScriptSources(root = process.cwd()): string[] {
  const testRoot = resolve(root, 'tests/e2e');
  return walk(testRoot)
    .filter((path) => path.endsWith('.ts'))
    .map((path) => relative(root, path).split(sep).join('/'))
    .sort();
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

const RAW_BROWSER_CONTEXT_PATTERN = /\b(?:browser|chromium|firefox|webkit)\s*\.\s*new(?:Context|Page)\s*\(/g;

export function findUnauditedRawBrowserContexts(source: string, path: string): string[] {
  return [...source.matchAll(RAW_BROWSER_CONTEXT_PATTERN)].map((match) => {
    const lineNumber = source.slice(0, match.index).split('\n').length;
    return `${path}:${lineNumber}`;
  });
}

function importsBasePlaywrightTest(source: string): boolean {
  return [...source.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]@playwright\/test['"]\s*;?\s*$/gm)]
    .flatMap((match) => match[1].split(','))
    .map((binding) => binding.trim())
    .some((binding) => /^test(?:\s+as\s+\w+)?$/.test(binding));
}

export function findUnauditedBasePageFixture(source: string, path: string): string[] {
  if (!importsBasePlaywrightTest(source)) return [];
  const automaticPageUse = /async\s*\(\s*\{[^}]*\bpage\b/.exec(source);
  if (!automaticPageUse) return [];
  const lineNumber = source.slice(0, automaticPageUse.index).split('\n').length;
  return [`${path}:${lineNumber}`];
}

export interface E2ESoftPassFinding {
  readonly path: string;
  readonly lane: string;
  readonly title: string;
  readonly line: number;
  readonly declaration: 'test' | 'skip' | 'fixme';
  readonly directCatchFalseCount: number;
  readonly fixedWaitCount: number;
  readonly unconditionalAssertionCount: number;
  readonly conditionalAssertionCount: number;
  readonly dynamicSkipCount: number;
}

function testDeclarationKind(expression: ts.Expression): E2ESoftPassFinding['declaration'] | undefined {
  if (ts.isIdentifier(expression) && expression.text === 'test') return 'test';
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'test'
  ) {
    if (expression.name.text === 'skip' || expression.name.text === 'fixme') {
      return expression.name.text;
    }
  }
  return undefined;
}

function staticString(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function isFalseReturningFunction(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  if (node.body.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (!ts.isBlock(node.body)) return false;
  return node.body.statements.some(
    (statement) => ts.isReturnStatement(statement) && statement.expression?.kind === ts.SyntaxKind.FalseKeyword
  );
}

function isDirectCatchFalse(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'catch' &&
    node.arguments.length === 1 &&
    isFalseReturningFunction(node.arguments[0])
  );
}

function isWaitForTimeout(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'waitForTimeout';
}

function isExpectCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === 'expect';
}

function isDynamicTestSkip(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'test' &&
    node.expression.name.text === 'skip'
  );
}

function inspectTestBody(
  body: ts.ConciseBody
): Omit<E2ESoftPassFinding, 'path' | 'lane' | 'title' | 'line' | 'declaration'> {
  let directCatchFalseCount = 0;
  let fixedWaitCount = 0;
  let unconditionalAssertionCount = 0;
  let conditionalAssertionCount = 0;
  let dynamicSkipCount = 0;

  const visit = (node: ts.Node, conditionalDepth: number): void => {
    if (ts.isCallExpression(node)) {
      if (isDirectCatchFalse(node)) directCatchFalseCount += 1;
      if (isWaitForTimeout(node)) fixedWaitCount += 1;
      if (isDynamicTestSkip(node)) dynamicSkipCount += 1;
      if (isExpectCall(node)) {
        if (conditionalDepth > 0) conditionalAssertionCount += 1;
        else unconditionalAssertionCount += 1;
      }
    }

    if (ts.isIfStatement(node)) {
      visit(node.expression, conditionalDepth);
      visit(node.thenStatement, conditionalDepth + 1);
      if (node.elseStatement) visit(node.elseStatement, conditionalDepth + 1);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, conditionalDepth);
      visit(node.whenTrue, conditionalDepth + 1);
      visit(node.whenFalse, conditionalDepth + 1);
      return;
    }
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      ts.forEachChild(node, (child) => visit(child, conditionalDepth + 1));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, conditionalDepth));
  };
  visit(body, 0);

  return {
    directCatchFalseCount,
    fixedWaitCount,
    unconditionalAssertionCount,
    conditionalAssertionCount,
    dynamicSkipCount,
  };
}

/**
 * Produce a deterministic, test-level inventory of mechanically observable
 * false-green and timing debt. This is intentionally conservative: helper
 * assertions are not inferred, so a zero static assertion is a review item,
 * not a claim that the test has no assertion anywhere in its call graph.
 */
export function analyzeE2ESoftPassSource(source: string, path: string, lane = 'unassigned'): E2ESoftPassFinding[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: E2ESoftPassFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const declaration = testDeclarationKind(node.expression);
      const title = staticString(node.arguments[0]);
      const callback = node.arguments.find(
        (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      );
      if (declaration && title && callback) {
        const details = inspectTestBody(callback.body);
        if (
          declaration !== 'test' ||
          details.directCatchFalseCount > 0 ||
          details.fixedWaitCount > 0 ||
          details.unconditionalAssertionCount === 0 ||
          details.conditionalAssertionCount > 0 ||
          details.dynamicSkipCount > 0
        ) {
          findings.push({
            path,
            lane,
            title,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            declaration,
            ...details,
          });
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export interface E2ERuntimeAudit {
  readonly specCount: number;
  readonly laneCounts: Readonly<Record<string, number>>;
  readonly discoveryCounts: Readonly<Record<string, number>>;
  readonly directCatchFalseCount: number;
  readonly fixedWaitCount: number;
  readonly unauditedRawContextCount: number;
  readonly unauditedBasePageFixtureCount: number;
  readonly softPassInventory: readonly E2ESoftPassFinding[];
}

export function playwrightLaneDiscoveryArguments(lane: E2ELaneContract): string[] {
  return [
    'test',
    '--config',
    lane.config,
    '--list',
    '--reporter=line',
    ...(lane.discoveryGrep ? ['--grep', lane.discoveryGrep] : []),
    ...lane.specs,
  ];
}

function discoverPlaywrightTestCount(
  root: string,
  lane: E2ELaneContract,
  env: Readonly<Record<string, string>> = {}
): number {
  const cli = resolve(root, 'node_modules/@playwright/test/cli.js');
  if (!existsSync(cli)) {
    throw new Error('Playwright CLI is required to audit E2E lane discovery');
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'true',
    PW_TEST_HTML_REPORT_OPEN: 'never',
    ...env,
  };
  // The manifest contract runs under Jest as well as the standalone audit.
  // Playwright rejects test declarations when it inherits another runner's
  // transform/runtime markers, so give the discovery child a clean runner.
  for (const name of [
    'JEST_WORKER_ID',
    'NODE_OPTIONS',
    'PW_TEST_SOURCE_TRANSFORM',
    'PW_TEST_SOURCE_TRANSFORM_SCOPE',
    'PW_TEST_SOURCE_TRANSFORM_TS_CONFIG',
  ]) {
    delete childEnv[name];
  }

  const result = spawnSync(
    process.execPath,
    [cli, ...playwrightLaneDiscoveryArguments(lane)],
    {
      cwd: root,
      encoding: 'utf8',
      env: childEnv,
      timeout: 60_000,
    }
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(
      `Playwright discovery failed for ${lane.id} via ${lane.config} (exit ${result.status ?? 'signal'}): ${output.trim()}`
    );
  }
  const match = output.match(/Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?/);
  if (!match) throw new Error(`Playwright discovery count missing for ${lane.id} via ${lane.config}`);
  return Number(match[1]);
}

export function auditE2ERuntimeManifest(root = process.cwd()): E2ERuntimeAudit {
  const manifest = loadPublicE2ERuntimeManifest(root);
  const laneIds = manifest.lanes.map((lane) => lane.id);

  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const configSource = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
  if (!configSource.includes('loadPublicE2ERuntimeManifest')) {
    throw new Error('Public Playwright config must use the strict v3 manifest loader');
  }
  if (!configSource.includes('specsOutsideLanePatterns(runtimeManifest, selectedRuntimeLane)')) {
    throw new Error('Public Playwright discovery must derive lane exclusions from the runtime manifest');
  }
  if (!configSource.includes('process.env.E2E_RUNTIME_LANE')) {
    throw new Error('Public Playwright config must select lanes through E2E_RUNTIME_LANE');
  }
  for (const forbidden of ['E2E_DEMO_JOURNEY', 'ACCESSIBILITY_E2E_DISPOSABLE']) {
    if (configSource.includes(forbidden)) {
      throw new Error(`Public Playwright config retains private selector ${forbidden}`);
    }
  }
  const scrubIndex = configSource.indexOf('Object.assign(process.env, scrubProviderCredentialEnv(process.env)');
  const dotenvIndex = configSource.indexOf('dotenv.config(');
  if (scrubIndex < 0 || dotenvIndex < 0 || scrubIndex > dotenvIndex) {
    throw new Error('Public zero-spend Playwright config must scrub provider credentials before dotenv');
  }
  for (const required of [
    "CLAUDE_CHAT_ENABLED: 'false'",
    "INNGEST_ENABLED: 'false'",
    "MAINTENANCE_PAUSED: 'true'",
    "NEXT_PUBLIC_INNGEST_ENABLED: 'false'",
  ]) {
    if (!configSource.includes(required)) {
      throw new Error(`Public zero-spend Playwright config is missing ${required}`);
    }
  }

  const networkFixture = readFileSync(resolve(root, 'tests/e2e/network-only-fixtures.ts'), 'utf8');
  for (const required of [
    'installLoopbackNetworkAudit(page, audit)',
    "assertNoExternalBrowserRequests(audit, 'Network-only Playwright page')",
  ]) {
    if (!networkFixture.includes(required)) {
      throw new Error(`Network-only Playwright fixture is missing ${required}`);
    }
  }
  for (const lane of manifest.lanes) {
    if (!existsSync(resolve(root, lane.config))) {
      throw new Error(`E2E lane ${lane.id} references missing config ${lane.config}`);
    }
    const command = packageJson.scripts?.[lane.command];
    if (!command) {
      throw new Error(`E2E lane ${lane.id} references missing npm script ${lane.command}`);
    }
    if (!command.includes(`E2E_RUNTIME_LANE=${lane.id}`)) {
      throw new Error(`E2E lane ${lane.id} npm script must select E2E_RUNTIME_LANE=${lane.id}`);
    }
  }
  const localCommand = packageJson.scripts?.[laneById(manifest, 'local-smoke').command] ?? '';
  if (!localCommand.includes('E2E_REUSE_EXISTING_SERVER=true')) {
    throw new Error('Local-smoke npm script must explicitly reuse the caller-owned server');
  }
  const publicationCommand = packageJson.scripts?.[laneById(manifest, 'report-publication').command] ?? '';
  if (!publicationCommand.includes('REPORT_DESIGN_E2E=1')) {
    throw new Error('Report-publication npm script must explicitly enable its self-contained browser contract');
  }

  for (const lane of manifest.lanes) {
    if (lane.status !== 'manual') continue;
    const reasons = unprovisionableRuntimeDependencies(lane.contract);
    if (reasons.length === 0) {
      throw new Error(
        `E2E lane ${lane.id} is marked manual but declares no runtime the automated public gate cannot provision`
      );
    }
  }

  const specs = discoverE2ESpecs(root);
  const known = new Set(specs);
  const explicitOwners = explicitSpecLaneMap(manifest);
  for (const spec of explicitOwners.keys()) {
    if (!known.has(spec)) throw new Error(`E2E runtime manifest references missing spec ${spec}`);
  }
  const unowned = specs.filter((spec) => !explicitOwners.has(spec));
  if (unowned.length > 0) {
    throw new Error(`E2E specs have no explicit runtime owner: ${unowned.join(', ')}`);
  }
  for (const retired of manifest.retiredSpecs) {
    if (known.has(retired.path) || existsSync(resolve(root, retired.path))) {
      throw new Error(`Retired E2E spec still exists: ${retired.path}`);
    }
    for (const replacement of retired.replacements) {
      if (!known.has(replacement)) {
        throw new Error(`Retired E2E spec ${retired.path} references missing replacement ${replacement}`);
      }
      if (!explicitOwners.has(replacement)) {
        throw new Error(`Retired E2E replacement ${replacement} has no active runtime owner`);
      }
    }
  }

  const laneCounts: Record<string, number> = Object.fromEntries(laneIds.map((id) => [id, 0]));
  for (const spec of specs) laneCounts[resolveSpecLane(manifest, spec)] += 1;

  const executableSources = discoverE2ETypeScriptSources(root);
  const sources = executableSources.map((source) => readFileSync(resolve(root, source), 'utf8')).join('\n');
  const directCatchFalseCount = countMatches(sources, /\.catch\(\s*\(\s*\)\s*=>\s*false\s*\)/g);
  const fixedWaitCount = countMatches(sources, /\.waitForTimeout\s*\(/g);
  if (directCatchFalseCount > manifest.ratchets.directCatchFalseMax) {
    throw new Error(
      `E2E direct catch-false debt grew: ${directCatchFalseCount} > ${manifest.ratchets.directCatchFalseMax}`
    );
  }
  if (fixedWaitCount > manifest.ratchets.fixedWaitMax) {
    throw new Error(`E2E fixed-wait debt grew: ${fixedWaitCount} > ${manifest.ratchets.fixedWaitMax}`);
  }

  const unauditedRawContexts = executableSources.flatMap((sourcePath) =>
    findUnauditedRawBrowserContexts(readFileSync(resolve(root, sourcePath), 'utf8'), sourcePath)
  );
  if (unauditedRawContexts.length > 0) {
    throw new Error(
      `Active E2E specs must create manual contexts through newAuditedContext: ${unauditedRawContexts.join(', ')}`
    );
  }

  const guardedLaneIds = new Set(
    manifest.lanes
      .filter(
        (lane) =>
          lane.contract.externalNetwork === 'browser-forbidden' ||
          lane.contract.externalNetwork === 'browser-loopback-only'
      )
      .map((lane) => lane.id)
  );
  const unauditedBasePageFixtures = specs.flatMap((spec) => {
    if (!guardedLaneIds.has(resolveSpecLane(manifest, spec))) return [];
    return findUnauditedBasePageFixture(readFileSync(resolve(root, spec), 'utf8'), spec);
  });
  if (unauditedBasePageFixtures.length > 0) {
    throw new Error(
      `Guarded E2E specs using the automatic page must import a network fixture: ${unauditedBasePageFixtures.join(', ')}`
    );
  }

  const softPassInventory = specs.flatMap((spec) =>
    analyzeE2ESoftPassSource(readFileSync(resolve(root, spec), 'utf8'), spec, resolveSpecLane(manifest, spec))
  );
  const findingKeys = new Set(softPassInventory.map((finding) => `${finding.path}\0${finding.title}`));
  for (const review of manifest.assertionReviews) {
    if (!known.has(review.path)) {
      throw new Error(`Assertion review references missing spec ${review.path}`);
    }
    if (!findingKeys.has(`${review.path}\0${review.title}`)) {
      throw new Error(`Assertion review ${review.path} :: ${review.title} no longer matches an inventory finding`);
    }
  }

  // `--list` loads test modules and applies each manifest-selected config
  // without starting web servers, emulators, or browsers. Every lane is driven
  // through the same environment key; adding a lane therefore cannot require a
  // new hardcoded discovery branch in this audit.
  const discoveryCounts = Object.fromEntries(
    manifest.lanes.map((lane) => [
      lane.id,
      discoverPlaywrightTestCount(root, lane, { E2E_RUNTIME_LANE: lane.id }),
    ])
  );
  for (const [lane, count] of Object.entries(discoveryCounts)) {
    const floor = manifest.ratchets.discoveryMinByLane[lane];
    if (count < floor) {
      throw new Error(`E2E lane ${lane} discovered ${count} tests below its floor ${floor}`);
    }
  }

  return {
    specCount: specs.length,
    laneCounts,
    discoveryCounts,
    directCatchFalseCount,
    fixedWaitCount,
    unauditedRawContextCount: unauditedRawContexts.length,
    unauditedBasePageFixtureCount: unauditedBasePageFixtures.length,
    softPassInventory,
  };
}
