/**
 * @file app/api/debug/apply-schema-migration/route.ts
 * @description Admin-gated runner for the Neo4j schema migration list.
 *
 * GET  /api/debug/apply-schema-migration              List applied migrations.
 * POST /api/debug/apply-schema-migration              Apply all pending.
 * POST /api/debug/apply-schema-migration?name=NAME    Apply one automatic migration by name.
 * POST ... &force=true                                Re-apply even if recorded.
 *
 * Auth: admin required. Development only. Manual migrations remain CLI-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/debug/apply-schema-migration');

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  try {
    const { listAppliedMigrations, MIGRATIONS } = await import('@/lib/graph/schema-migrations');
    const applied = await listAppliedMigrations();
    const _appliedSet = new Set(applied.map((a) => a.name));
    return NextResponse.json({
      total: MIGRATIONS.length,
      applied: applied.length,
      migrations: MIGRATIONS.map((m) => ({
        name: m.name,
        description: m.description,
        appliedAt: applied.find((a) => a.name === m.name)?.appliedAt ?? null,
      })),
      unknown: applied.filter((a) => !MIGRATIONS.find((m) => m.name === a.name)),
    });
  } catch (e) {
    log.error('listAppliedMigrations failed', e instanceof Error ? e : new Error(String(e)));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  const url = new URL(request.url);
  const name = url.searchParams.get('name') ?? undefined;
  const force = url.searchParams.get('force') === 'true';

  try {
    const { applyMigrationByName, applyPendingMigrations, MANUAL_MIGRATIONS } = await import(
      '@/lib/graph/schema-migrations'
    );
    if (name) {
      if (MANUAL_MIGRATIONS.some((migration) => migration.name === name)) {
        return NextResponse.json(
          { error: 'Manual migrations must be run through the operator CLI' },
          { status: 403 }
        );
      }
      const r = await applyMigrationByName(name, { force });
      return NextResponse.json(r);
    }
    const results = await applyPendingMigrations();
    return NextResponse.json({ results });
  } catch (e) {
    log.error('apply-schema-migration failed', e instanceof Error ? e : new Error(String(e)));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
