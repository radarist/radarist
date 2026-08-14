/**
 * Authenticated, same-origin export of one persisted visualization image.
 * The client supplies only the visualization ID; the server resolves the exact
 * owner-scoped Storage object from Firestore, so this is not an arbitrary URL proxy.
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { downloadStoredVisualization } from '@/lib/storage';
import {
  buildVisualizationExportFilename,
  getVisualizationExportFormat,
  resolveOwnedVisualizationStoragePath,
} from '@/lib/visualization-export';
import { assertVisualizationExportPayload } from '@/lib/visualization-export-validation';
import { getVisualizationById } from '@/lib/visualizations';

const log = createLogger('api/visualizations/[id]/export');

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const visualization = await getVisualizationById(id);
    if (!visualization || visualization.userId !== auth.uid) {
      return NextResponse.json({ error: 'Visualization not found' }, { status: 404 });
    }

    const format = getVisualizationExportFormat(visualization.mimeType);
    if (!format) {
      return NextResponse.json({ error: 'Visualization media type is not exportable' }, { status: 415 });
    }

    const isLegacyStorageRecord =
      visualization.storageObjectPath === undefined || visualization.storageObjectPath === null;
    const storagePath = resolveOwnedVisualizationStoragePath({
      storageObjectPath: visualization.storageObjectPath,
      imageUrl: visualization.imageUrl,
      uid: auth.uid,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      storageEmulatorHost: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
    });
    if (!storagePath) {
      return NextResponse.json({ error: 'Visualization export is unavailable for this record' }, { status: 409 });
    }

    let storedImage;
    try {
      storedImage = await downloadStoredVisualization(storagePath, {
        ownerId: auth.uid,
        expectedMimeType: format.mimeType,
        allowMissingOwnerMetadata: isLegacyStorageRecord,
      });
    } catch (error) {
      log.error('Storage read failed', error instanceof Error ? error : new Error(String(error)), {
        visualizationId: id,
      });
      return NextResponse.json({ error: 'Visualization storage is unavailable' }, { status: 502 });
    }

    if (!storedImage) {
      return NextResponse.json({ error: 'Visualization image not found' }, { status: 404 });
    }
    if (storedImage.uploadedBy && storedImage.uploadedBy !== auth.uid) {
      return NextResponse.json({ error: 'Visualization export is unavailable for this record' }, { status: 409 });
    }

    try {
      assertVisualizationExportPayload(storedImage.content, format.mimeType, storedImage.mimeType, {
        allowLegacyStaticSvg: isLegacyStorageRecord,
      });
    } catch (error) {
      log.warn('Stored visualization failed export validation', {
        visualizationId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ error: 'Stored visualization image is invalid' }, { status: 502 });
    }

    const filename = buildVisualizationExportFilename(visualization.title, format.mimeType);
    if (!filename) {
      return NextResponse.json({ error: 'Visualization media type is not exportable' }, { status: 415 });
    }

    return new NextResponse(new Uint8Array(storedImage.content), {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': storedImage.content.byteLength.toString(),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': format.mimeType,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    log.error('Failed to export visualization', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to export visualization' }, { status: 500 });
  }
}
