'use client';

import { useEffect, useState } from 'react';
import { buildReportPreviewHtml } from '@/app/reports/[id]/report-frame-content';
import { loadReportBrandCss } from '@/lib/reports/load-report-brand-css';
import { SHARE_REPORT_IFRAME_SANDBOX } from './share-iframe';

interface PublicReportPreviewProps {
  html: string;
  title: string;
}

/**
 * Browser-side adapter for the shared static report renderer. DOMParser is a
 * browser API, so the server route sends report HTML only as a React prop and
 * the iframe remains empty until parser-normalized content is ready.
 */
export function PublicReportPreview({ html, title }: PublicReportPreviewProps) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    try {
      setPreviewError(false);
      setSrcDoc(buildReportPreviewHtml(html, { brandCss: null }));
    } catch {
      setSrcDoc(null);
      setPreviewError(true);
      return () => controller.abort();
    }

    void loadReportBrandCss({ signal: controller.signal }).then((brandCss) => {
      if (!cancelled && brandCss) {
        try {
          setSrcDoc(buildReportPreviewHtml(html, { brandCss }));
        } catch {
          // Preserve the already-rendered static fallback.
        }
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [html]);

  if (previewError) {
    return (
      <div role="alert" style={{ flex: 1, width: '100%', padding: '2rem', textAlign: 'center' }}>
        Shared report preview unavailable. Try reloading or ask the owner for a downloaded copy.
      </div>
    );
  }

  // Do not server-render an empty iframe. During a fresh shared-report request,
  // Next dev can briefly retain that server node while the hydrated client node
  // is committed, producing two identically titled frames. A non-frame loading
  // surface keeps the public one-report/one-frame contract deterministic.
  if (!srcDoc) {
    return <div role="status" aria-label="Loading shared report" style={{ flex: 1, width: '100%' }} />;
  }

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox={SHARE_REPORT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      title={title}
      style={{ flex: 1, width: '100%', border: 'none', display: 'block' }}
    />
  );
}
