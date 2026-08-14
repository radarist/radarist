/**
 * Debug endpoint to create test signals for agent testing
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { adminCreateSignal } from '@/lib/signals-admin';

export async function POST(request: NextRequest) {
  // Require admin authentication + development mode only
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  try {
    const testSignals = [
      {
        title: 'AI-Powered Robotics Platform',
        description: 'New AI platform for autonomous robotics control',
        source: 'patents' as const,
        type: 'Technology' as const,
        status: 'Detected' as const,
        url: 'https://example.com/patent/123',
        detectedAt: Date.now(),
        relevanceScore: 0,
        alignmentScore: 0,
        metadata: {
          confidence: 0.85,
          keywords: ['AI', 'robotics', 'autonomous'],
        },
      },
      {
        title: 'Quantum Computing Breakthrough',
        description: 'Novel approach to quantum error correction',
        source: 'papers' as const,
        type: 'Technology' as const,
        status: 'Detected' as const,
        url: 'https://example.com/paper/456',
        detectedAt: Date.now(),
        relevanceScore: 0,
        alignmentScore: 0,
        metadata: {
          confidence: 0.92,
          keywords: ['quantum', 'computing', 'error correction'],
        },
      },
      {
        title: 'Sustainable Energy Startup Funding',
        description: 'Series A funding for solar innovation company',
        source: 'funding' as const,
        type: 'Company' as const,
        status: 'Detected' as const,
        url: 'https://example.com/funding/789',
        detectedAt: Date.now(),
        relevanceScore: 0,
        alignmentScore: 0,
        metadata: {
          confidence: 0.78,
          keywords: ['sustainable', 'energy', 'solar'],
          fundingAmount: 15000000,
        },
      },
    ];

    const createdSignals = [];
    for (const signalData of testSignals) {
      const signal = await adminCreateSignal(signalData as any);
      createdSignals.push(signal);
    }

    return NextResponse.json({
      success: true,
      message: `Created ${createdSignals.length} test signals`,
      signals: createdSignals.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
