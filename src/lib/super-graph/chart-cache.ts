/**
 * @file lib/super-graph/chart-cache.ts
 * @description REPORT-012 Task 2.2 — mission-scoped chart cache enabling
 * insert-by-reference composition.
 *
 * Why: `renderDiagram` output re-typed by the LLM can lose byte identity. The
 * composer therefore inlines chart SVG FROM THIS CACHE by
 * `chartId`; the LLM only ever copies the short id into a `chart-ref` block,
 * so the rendered bytes (theming, provenance signature, normalization) reach
 * the published report untouched.
 *
 * Storage: `os.tmpdir()/impulse-missions/<missionId>/charts/<chartId>.svg` —
 * the same root the existing `persistSvg` re-read path uses (outside the
 * project tree so the dev file-watcher never fires mid-mission). Same-instance
 * assumption as the draft flow: render and publish happen on one server.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '@/lib/logger';

const log = createLogger('super-graph/chart-cache');

const CACHE_ROOT = path.join(os.tmpdir(), 'impulse-missions');

/** Matches the `chart-ref.chartId` schema in lib/schemas/report-blocks.ts. */
const CHART_ID_RE = /^[a-z0-9-]{4,64}$/;
const MISSION_ID_RE = /^mission-[a-zA-Z0-9_-]+$/;

/**
 * Resolve the cache path for (missionId, chartId), or null when either id is
 * malformed or the resolved path escapes the cache root (defense in depth —
 * both ids are also regex-validated).
 */
function chartPath(missionId: string, chartId: string): string | null {
  if (!MISSION_ID_RE.test(missionId) || !CHART_ID_RE.test(chartId)) return null;
  const resolved = path.resolve(CACHE_ROOT, missionId, 'charts', `${chartId}.svg`);
  if (!resolved.startsWith(CACHE_ROOT + path.sep)) return null;
  return resolved;
}

/** Mint a cache id for a rendered chart: `<kind>-<title-slug>-<t36>` (≤64 chars). */
export function mintChartId(kind: string, title: string | undefined): string {
  const safeKind = (kind || 'chart').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'chart';
  const safeTitle =
    (title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'untitled';
  const stamp = Date.now().toString(36);
  return `${safeKind}-${safeTitle}-${stamp}`.slice(0, 64).replace(/-+$/, '');
}

/** Persist a rendered SVG under (missionId, chartId). Throws on invalid ids. */
export async function putChartSvg(missionId: string, chartId: string, svg: string): Promise<void> {
  const filePath = chartPath(missionId, chartId);
  if (!filePath) throw new Error(`chart-cache: invalid missionId/chartId (${missionId}, ${chartId})`);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, svg, 'utf-8');
  } catch (err) {
    log.error('chart-cache write failed', err instanceof Error ? err : new Error(String(err)), {
      missionId,
      chartId,
    });
    throw err;
  }
}

/** Read a cached SVG. Returns null for unknown/malformed ids (never throws). */
export async function getChartSvg(missionId: string, chartId: string): Promise<string | null> {
  const filePath = chartPath(missionId, chartId);
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image-ref cache (REPORT-012 T2.4/T2.6) — same conventions, `images/` subdir.
// Stores the SOURCE URL of a generated image; the composer resolves it through
// `inlineImage` (bounded data: URI) at compose time.
// ---------------------------------------------------------------------------

function imagePath(missionId: string, imageId: string): string | null {
  if (!MISSION_ID_RE.test(missionId) || !CHART_ID_RE.test(imageId)) return null;
  const resolved = path.resolve(CACHE_ROOT, missionId, 'images', `${imageId}.url`);
  if (!resolved.startsWith(CACHE_ROOT + path.sep)) return null;
  return resolved;
}

/** Persist a generated image's source URL under (missionId, imageId). */
export async function putImageUrl(missionId: string, imageId: string, url: string): Promise<void> {
  const filePath = imagePath(missionId, imageId);
  if (!filePath) throw new Error(`chart-cache: invalid missionId/imageId (${missionId}, ${imageId})`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, url, 'utf-8');
}

/** Read a cached image source URL. Returns null for unknown/malformed ids. */
export async function getImageUrl(missionId: string, imageId: string): Promise<string | null> {
  const filePath = imagePath(missionId, imageId);
  if (!filePath) return null;
  try {
    return (await fs.readFile(filePath, 'utf-8')).trim();
  } catch {
    return null;
  }
}
