#!/usr/bin/env node
/**
 * code-graph.mjs — dependency-free structural import-graph analyzer for `src/`.
 *
 * Parses import / export-from / dynamic-import / require specifiers with a
 * proper string/comment-aware scanner (NOT regex comment stripping — a `/*`
 * inside a `//` line comment or a string must never open a block comment), and
 * computes four structural-health signals used by the CI ratchet gate:
 *
 *   - import cycles            (Tarjan strongly-connected components, size > 1)
 *   - orphan modules           (fan-in 0, excluding src/app + Next framework files)
 *   - client→server violations (a 'use client' file importing a server-only
 *                               module at RUNTIME — type-only imports are erased)
 *   - unresolved/broken imports (an internal specifier that resolves to no file)
 *
 * Used both as a report and as the data source for `code-graph-gate.mjs`.
 * Zero runtime dependencies (node:fs / node:path / node:url only).
 *
 * Usage:
 *   node scripts/code-graph.mjs            # human-readable summary
 *   node scripts/code-graph.mjs --json     # full JSON report to stdout
 *   node scripts/code-graph.mjs --output <path>   # write JSON report to a file
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');

export const PUBLIC_EXTERNAL_ENTRYPOINTS = [
  'scripts/generate-capability-catalog.ts',
  'scripts/recover-interrupted-job-runs.ts',
];

const BASELINE = path.join(ROOT, 'scripts/code-graph-baseline.json');

function loadDeclaredExternalEntrypoints() {
  if (!fs.existsSync(BASELINE)) return [...PUBLIC_EXTERNAL_ENTRYPOINTS];
  const parsed = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  if (!Array.isArray(parsed.externalEntrypoints) || parsed.externalEntrypoints.length === 0) {
    throw new Error('code-graph baseline must declare externalEntrypoints');
  }
  const normalized = parsed.externalEntrypoints.map((entry) => {
    if (
      typeof entry !== 'string' ||
      !entry.startsWith('scripts/') ||
      entry.includes('\\') ||
      entry.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`Invalid code-graph external entrypoint: ${JSON.stringify(entry)}`);
    }
    return entry.normalize('NFC');
  });
  if (new Set(normalized.map((entry) => entry.toLowerCase())).size !== normalized.length) {
    throw new Error('code-graph external entrypoints must be case-fold unique');
  }
  return [...normalized].sort();
}

// Specifier extensions that are assets, not TS modules (so they aren't "broken").
const ASSET_EXT = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.md',
  '.mdx',
  '.txt',
  '.yaml',
  '.yml',
  '.html',
  '.wasm',
  '.csv',
]);

// Client/server boundary contract: these may not be imported at
// runtime from a 'use client' component.
const SERVER_ONLY_FILES = new Set(['src/lib/firebase-admin.ts', 'src/lib/ai/client.ts']);
const SERVER_ONLY_DIRS = ['src/lib/inngest/', 'src/lib/graph/'];
// Documented client-safe escape hatches that live inside an otherwise
// server-only dir (type-only module + lazy client-safe service factory).
const CLIENT_SAFE = new Set([
  'src/lib/graph/types.ts',
  'src/lib/graph/client-safe.ts',
  // Pure URL/log helper that lives under graph/ but imports no driver/admin —
  // verified client-safe, intentionally consumed by impulse/* client components.
  'src/lib/graph/insight-actions.ts',
  // Business-entity identity and its entityType vocabulary are pure data and
  // functions whose only import is a TYPE
  // from '@/lib/types' — no neo4j driver, no admin SDK, nothing lazy. They live
  // under graph/ because the identity rule and the label vocabulary are one
  // contract, and RelationsTab needs it to stop naming a node by its `entityType`
  // property. Verified by `npm run build`: neither pulls a server-only module
  // into the client graph.
  'src/lib/graph/business-entity-identity.ts',
  'src/lib/graph/entity-type-vocab.ts',
]);

// Next.js App Router convention filenames — framework-owned entrypoints, never orphans.
const FRAMEWORK = new Set([
  'page',
  'route',
  'layout',
  'loading',
  'error',
  'not-found',
  'middleware',
  'proxy',
  'template',
  'default',
  'global-error',
  'sitemap',
  'robots',
  'manifest',
  'opengraph-image',
  'icon',
  'apple-icon',
  'instrumentation',
]);

const toRel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const baseName = (r) => path.basename(r).replace(/\.(ts|tsx)$/, '');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '__tests__', '.next', 'dist'].includes(e.name)) continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** State-machine comment stripper that respects strings and template literals. */
function stripComments(s) {
  let out = '',
    i = 0;
  const n = s.length;
  let st = 'code';
  while (i < n) {
    const c = s[i],
      d = s[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') {
        st = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        st = 'block';
        i += 2;
        continue;
      }
      if (c === "'") {
        st = 'sq';
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        st = 'dq';
        out += c;
        i++;
        continue;
      }
      if (c === '`') {
        st = 'tpl';
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (st === 'line') {
      if (c === '\n') {
        st = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (st === 'block') {
      if (c === '*' && d === '/') {
        st = 'code';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // string / template states: preserve content, honor escapes, exit on close
    out += c;
    if (c === '\\' && i + 1 < n) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code';
    i++;
  }
  return out;
}

/** Extract module specifiers, split into runtime vs type-only (statement-level). */
function specifiers(src) {
  const runtime = [],
    type = [];
  let m;
  const typeFrom = /\b(?:import|export)\s+type\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  while ((m = typeFrom.exec(src))) type.push(m[1]);
  const runFrom = /\b(?:import|export)\s+(?!type\b)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  while ((m = runFrom.exec(src))) runtime.push(m[1]);
  const dyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src))) runtime.push(m[1]);
  const side = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((m = side.exec(src))) runtime.push(m[1]);
  const req = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = req.exec(src))) runtime.push(m[1]);
  return { runtime, type };
}

function resolveSpec(spec, fromAbs, fileSet) {
  if (spec === 'server-only' || spec === 'client-only') return { kind: 'ignore' };
  let baseRel;
  if (spec.startsWith('@/')) baseRel = 'src/' + spec.slice(2);
  else if (spec.startsWith('.'))
    baseRel = path
      .relative(ROOT, path.resolve(path.dirname(fromAbs), spec))
      .split(path.sep)
      .join('/');
  else return { kind: 'external' };
  const ext = path.extname(baseRel).toLowerCase();
  if (ext && ASSET_EXT.has(ext)) return { kind: 'asset' };
  const cands = [
    baseRel + '.ts',
    baseRel + '.tsx',
    baseRel + '.js',
    baseRel + '/index.ts',
    baseRel + '/index.tsx',
    baseRel + '/index.js',
  ];
  for (const c of cands) if (fileSet.has(c)) return { kind: 'internal', target: c };
  if (fileSet.has(baseRel)) return { kind: 'internal', target: baseRel };
  return { kind: 'unresolved', spec };
}

const isServerOnly = (t) =>
  SERVER_ONLY_FILES.has(t) || (SERVER_ONLY_DIRS.some((d) => t.startsWith(d)) && !CLIENT_SAFE.has(t));

/** Tarjan SCC (iterative) — returns components with > 1 member. */
function tarjan(adj) {
  let idx = 0;
  const index = {},
    low = {},
    onStack = {},
    stack = [],
    sccs = [];
  for (const start of Object.keys(adj)) {
    if (index[start] !== undefined) continue;
    const work = [[start, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0],
        pi = top[1];
      if (pi === 0) {
        index[v] = low[v] = idx++;
        stack.push(v);
        onStack[v] = true;
      }
      let recursed = false;
      const nbrs = adj[v] || [];
      if (pi < nbrs.length) {
        top[1]++;
        const w = nbrs[pi];
        if (index[w] === undefined) {
          work.push([w, 0]);
          recursed = true;
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (recursed) continue;
      if (pi >= nbrs.length) {
        if (low[v] === index[v]) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack[w] = false;
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1) sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low[p] = Math.min(low[p], low[v]);
        }
      }
    }
  }
  return sccs;
}

export function buildGraphFromView(view, externalEntrypoints = PUBLIC_EXTERNAL_ENTRYPOINTS) {
  const fileSet = new Set(
    [...view.keys()].filter(
      (repoPath) =>
        repoPath.startsWith('src/') &&
        /\.(ts|tsx)$/.test(repoPath) &&
        !/\.(test|spec)\.(ts|tsx)$/.test(repoPath) &&
        !/\.d\.ts$/.test(repoPath) &&
        !repoPath.split('/').includes('__tests__')
    )
  );
  const files = [...fileSet].sort();
  const fanIn = {},
    adj = {};
  const boundary = [],
    unresolved = [];
  for (const r of files) {
    fanIn[r] = 0;
    adj[r] = [];
  }

  for (const r of files) {
    const raw = view.get(r)?.bytes;
    if (typeof raw !== 'string') throw new Error(`Missing code-view bytes: ${r}`);
    const src = stripComments(raw);
    const isClient = /^\s*(['"])use client\1/.test(src);
    const { runtime, type } = specifiers(src);
    const seen = new Set();
    const runtimeTargets = new Set();

    const addEdge = (target) => {
      if (!seen.has(target) && target !== r) {
        seen.add(target);
        adj[r].push(target);
        fanIn[target]++;
      }
    };
    for (const spec of runtime) {
      const res = resolveSpec(spec, path.join(ROOT, r), fileSet);
      if (res.kind === 'internal') {
        runtimeTargets.add(res.target);
        addEdge(res.target);
      } else if (res.kind === 'unresolved') unresolved.push(`${r} -> ${res.spec}`);
    }
    for (const spec of type) {
      const res = resolveSpec(spec, path.join(ROOT, r), fileSet);
      if (res.kind === 'internal') addEdge(res.target);
      else if (res.kind === 'unresolved') unresolved.push(`${r} -> ${res.spec}`);
    }
    if (isClient) for (const t of runtimeTargets) if (isServerOnly(t)) boundary.push(`${r} -> ${t}`);
  }

  for (const entrypoint of externalEntrypoints) {
    const item = view.get(entrypoint);
    if (!item || typeof item.bytes !== 'string') throw new Error(`Missing declared external entrypoint: ${entrypoint}`);
    const absoluteEntrypoint = path.join(ROOT, entrypoint);
    const source = stripComments(item.bytes);
    const imports = specifiers(source);
    for (const spec of [...imports.runtime, ...imports.type]) {
      const resolved = resolveSpec(spec, absoluteEntrypoint, fileSet);
      if (resolved.kind === 'internal') fanIn[resolved.target]++;
    }
  }

  const cycles = tarjan(adj);
  const uniqSort = (a) => [...new Set(a)].sort();
  const orphans = Object.keys(fanIn)
    .filter((r) => fanIn[r] === 0 && !r.startsWith('src/app/') && !FRAMEWORK.has(baseName(r)))
    .sort();

  return {
    meta: {
      files: files.length,
      edges: Object.values(adj).reduce((s, a) => s + a.length, 0),
      scope: 'src/',
      externalEntrypoints: [...externalEntrypoints].sort(),
    },
    cycleMembers: uniqSort(cycles.flat()),
    cycles: cycles.map((c) => c.slice().sort()).sort((a, b) => b.length - a.length),
    orphans,
    boundary: uniqSort(boundary),
    unresolved: uniqSort(unresolved),
  };
}

export function buildGraph() {
  const externalEntrypoints = loadDeclaredExternalEntrypoints();
  const view = new Map();
  for (const absolute of walk(SRC)) view.set(toRel(absolute), { bytes: fs.readFileSync(absolute, 'utf8') });
  for (const entrypoint of externalEntrypoints) {
    const absolute = path.join(ROOT, entrypoint);
    if (!fs.existsSync(absolute)) throw new Error(`Missing declared external entrypoint: ${entrypoint}`);
    view.set(entrypoint, { bytes: fs.readFileSync(absolute, 'utf8') });
  }
  return buildGraphFromView(view, externalEntrypoints);
}

function main() {
  const args = process.argv.slice(2);
  const g = buildGraph();
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) fs.writeFileSync(args[outIdx + 1], JSON.stringify(g, null, 2) + '\n');
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(g, null, 2) + '\n');
    return;
  }
  console.log('Code-graph structural report (src/)');
  console.log(`  files=${g.meta.files}  edges=${g.meta.edges}`);
  console.log(
    `  cycles=${g.cycles.length} (members=${g.cycleMembers.length})  orphans=${g.orphans.length}  boundary=${g.boundary.length}  unresolved=${g.unresolved.length}`
  );
  if (g.cycles.length) console.log(`  largest cycle: ${g.cycles[0].length} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
