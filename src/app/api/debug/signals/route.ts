/**
 * Debug endpoint to check signal statuses
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { adminGetSignals } from '@/lib/signals-admin';

export async function GET(request: NextRequest) {
  // Require admin authentication + development mode only
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  try {
    const signals = await adminGetSignals();

    const statusCounts = signals.reduce(
      (acc, signal) => {
        acc[signal.status] = (acc[signal.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return NextResponse.json({
      total: signals.length,
      statusBreakdown: statusCounts,
      signals: signals.slice(0, 5).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        source: s.source,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
