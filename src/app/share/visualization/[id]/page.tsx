/**
 * @file app/share/visualization/[id]/page.tsx
 * @description Public share page for visualizations (no auth required)
 *
 * Server component that:
 * - Fetches the visualization directly from Firestore
 * - Checks shared status — blocks unshared
 * - Sets OG meta tags with og:image for rich link previews
 * - Renders full-size image with "Powered by Radarist" footer
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import type { Metadata } from 'next';
import { VisualizationMedia } from '@/components/infographics/VisualizationMedia';
import { createLogger } from '@/lib/logger';
import type { Visualization } from '@/lib/schemas/visualization';
import { readVisualizationById } from '@/lib/visualizations';

const log = createLogger('share/visualization/[id]');

type PublicVisualizationReadResult =
  | { status: 'shared'; visualization: Visualization }
  | { status: 'not-found' }
  | { status: 'not-shared' }
  | { status: 'unavailable' };

async function readPublicVisualization(id: string): Promise<PublicVisualizationReadResult> {
  try {
    const result = await readVisualizationById(id);
    if (result.status === 'not-found') return result;
    if (result.visualization.shared !== true) return { status: 'not-shared' };
    return { status: 'shared', visualization: result.visualization };
  } catch (error) {
    log.error('Public visualization metadata read failed', error instanceof Error ? error : new Error(String(error)), {
      visualizationId: id,
    });
    return { status: 'unavailable' };
  }
}

// ============================================================================
// Metadata
// ============================================================================

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const result = await readPublicVisualization(id);

  if (result.status === 'not-found') {
    return {
      title: 'Visualization Not Found',
      description: 'This visualization may have been deleted or the link is invalid.',
    };
  }

  if (result.status === 'not-shared') {
    return {
      title: 'Visualization Not Shared',
      description: 'This visualization is not publicly shared.',
    };
  }

  if (result.status === 'unavailable') {
    return {
      title: 'Visualization Temporarily Unavailable',
      description: 'This visualization cannot be loaded right now.',
    };
  }

  const viz = result.visualization;

  return {
    title: viz.title,
    description: viz.dataSnapshot?.description ?? viz.prompt,
    openGraph: {
      title: viz.title,
      description: viz.dataSnapshot?.description ?? viz.prompt,
      images: [viz.imageUrl],
    },
  };
}

// ============================================================================
// Page
// ============================================================================

export default async function SharedVisualizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await readPublicVisualization(id);

  if (result.status === 'not-found') {
    return (
      <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Visualization Not Found</h1>
        <p style={{ color: '#666' }}>This visualization may have been deleted or the link is invalid.</p>
      </div>
    );
  }

  if (result.status === 'not-shared') {
    return (
      <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Visualization Not Shared</h1>
        <p style={{ color: '#666' }}>This visualization is not publicly shared.</p>
      </div>
    );
  }

  if (result.status === 'unavailable') {
    return (
      <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Visualization Temporarily Unavailable</h1>
        <p style={{ color: '#666' }}>This visualization cannot be loaded right now.</p>
      </div>
    );
  }

  const viz = result.visualization;

  return (
    <div
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '40px 20px',
        fontFamily: 'system-ui',
      }}
    >
      <h1 style={{ fontSize: '28px', fontWeight: 600, marginBottom: '16px' }}>{viz.title}</h1>

      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          overflow: 'hidden',
          marginBottom: '24px',
        }}
      >
        <VisualizationMedia
          src={viz.imageUrl}
          alt={viz.title}
          width={viz.metadata?.width}
          height={viz.metadata?.height}
          variant="public"
          fit={viz.mimeType === 'image/svg+xml' ? 'contain' : 'cover'}
          testId="shared-visualization-media"
        />
      </div>

      {viz.dataSnapshot?.description && (
        <p style={{ color: '#666', fontSize: '14px', marginBottom: '24px' }}>{viz.dataSnapshot.description}</p>
      )}

      <footer
        style={{
          borderTop: '1px solid #e5e7eb',
          paddingTop: '16px',
          marginTop: '40px',
          textAlign: 'center',
          color: '#999',
          fontSize: '12px',
        }}
      >
        Powered by Radarist
      </footer>
    </div>
  );
}
