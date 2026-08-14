/**
 * @file app/api/debug/cleanup-rss-signals/route.ts
 * @description One-shot repair: rewrite signals whose description/aiSummary
 * still contain raw Google News RSS HTML (`<a href="...news.google.com...">`
 * + `<font color="#6f6f6f">`). These landed before the parseRSSXML
 * decode-then-strip fix (2026-04-17) — the ingest path is clean now.
 *
 * GET  /api/debug/cleanup-rss-signals?dryRun=true   -> report only
 * POST /api/debug/cleanup-rss-signals               -> execute
 *
 * Auth: admin required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';

const log = createLogger('api/debug/cleanup-rss-signals');

const HTML_MARKERS = /<a\s|<font\s|&lt;a\s|&lt;font\s/i;

function decodeHTMLEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return text.replace(/&[^;]+;/g, (e) => entities[e] ?? e);
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function cleanText(raw: string): string {
  if (!raw) return '';
  return decodeHTMLEntities(stripHTML(decodeHTMLEntities(raw)))
    .replace(/\s+/g, ' ')
    .trim();
}

interface CleanupStats {
  scanned: number;
  needsFix: number;
  clean: number;
  fixed: number;
  samples: Array<{ id: string; title: string }>;
}

async function runCleanup(dryRun: boolean): Promise<CleanupStats> {
  const stats: CleanupStats = { scanned: 0, needsFix: 0, clean: 0, fixed: 0, samples: [] };

  const snap = await db.collection('signals').get();
  stats.scanned = snap.size;

  const toFix: Array<{ id: string; update: Record<string, unknown>; title: string }> = [];

  snap.forEach((d) => {
    const data = d.data() as {
      description?: string;
      aiSummary?: string;
      title?: string;
      relevanceScore?: number;
    };
    const desc = data.description ?? '';
    const sum = data.aiSummary ?? '';
    if (!HTML_MARKERS.test(desc) && !HTML_MARKERS.test(sum)) {
      stats.clean++;
      return;
    }
    stats.needsFix++;
    const cleanedDesc = cleanText(desc);
    const cleanedSum = cleanText(sum);
    const update: Record<string, unknown> = {
      description: cleanedDesc,
      aiSummary: cleanedSum || cleanedDesc || data.title || '',
    };
    if ((data.relevanceScore ?? 0) === 0) update.relevanceScore = 50;
    toFix.push({ id: d.id, update, title: data.title ?? '' });
  });

  stats.samples = toFix.slice(0, 5).map((f) => ({ id: f.id, title: f.title.slice(0, 80) }));

  if (dryRun) return stats;

  // Batched writes (Firestore caps at 500 per batch).
  for (let i = 0; i < toFix.length; i += 400) {
    const chunk = toFix.slice(i, i + 400);
    const batch = db.batch();
    for (const f of chunk) batch.update(db.collection('signals').doc(f.id), f.update);
    await batch.commit();
    stats.fixed += chunk.length;
  }
  return stats;
}

export async function GET(request: NextRequest) {
  const adm = await requireAdmin(request);
  if (!adm.authenticated) return NextResponse.json({ error: adm.error }, { status: 401 });
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }
  try {
    const stats = await runCleanup(true);
    return NextResponse.json({ dryRun: true, ...stats });
  } catch (e) {
    log.error('cleanup dry-run failed', e instanceof Error ? e : new Error(String(e)));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const adm = await requireAdmin(request);
  if (!adm.authenticated) return NextResponse.json({ error: adm.error }, { status: 401 });
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }
  try {
    const stats = await runCleanup(false);
    log.info('cleanup executed', { stats });
    return NextResponse.json({ dryRun: false, ...stats });
  } catch (e) {
    log.error('cleanup execute failed', e instanceof Error ? e : new Error(String(e)));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
