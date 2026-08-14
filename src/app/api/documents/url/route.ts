/**
 * @file api/documents/url/route.ts
 * @description API endpoint for creating documents from URLs.
 *
 * This endpoint:
 * 1. Validates the URL (security + format)
 * 2. Checks for duplicate URLs
 * 3. Fetches and extracts content using Firecrawl
 * 4. Creates a document record
 * 5. Triggers background processing
 *
 * @phase Phase 8: URL Document Processing
 * @author Radarist Team
 * @created 2026-01-14
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/url');
import { z } from 'zod';
import {
  adminCreateDocument as createDocument,
  adminGetDocumentByNormalizedUrl as getDocumentByNormalizedUrl,
  adminUpdateDocument as updateDocument,
} from '@/lib/document-admin';
import { normalizeUrl, extractDomain, isValidUrl } from '@/lib/utils/url-normalize';
import { checkTdmPolicy } from '@/lib/tdm-policy';
import { inngest } from '@/lib/inngest/client';
import { processDocumentFromContent } from '@/lib/document-processing-service';
import { fetchUrlContentReceipted } from '@/lib/firecrawl-fetch';

// ============================================================================
// VALIDATION SCHEMA
// ============================================================================

const urlInputSchema = z.object({
  url: z.string().min(1, 'URL is required'),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// ============================================================================
// SECURITY VALIDATION
// ============================================================================

/**
 * Dangerous URL schemes that should be blocked.
 */
const DANGEROUS_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'about:'];

/**
 * Validate URL for security issues.
 * @returns Error message if invalid, null if valid
 */
function validateUrlSecurity(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Block dangerous schemes
    const scheme = parsed.protocol.toLowerCase();
    if (DANGEROUS_SCHEMES.some((d) => scheme.startsWith(d))) {
      return 'This URL scheme is not allowed for security reasons';
    }

    // Only allow http/https
    if (!['http:', 'https:'].includes(scheme)) {
      return 'Only HTTP and HTTPS URLs are supported';
    }

    // Block localhost/internal IPs (SSRF protection)
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local')
    ) {
      return 'Internal URLs are not allowed';
    }

    return null;
  } catch {
    return 'Invalid URL format';
  }
}

// ============================================================================
// CONTENT FETCHING — centralized in @/lib/firecrawl-fetch (ARUN-022).
// The Firecrawl provider call is receipted there; the basic HTTP fallback is
// zero-provider and emits no receipt.
// ============================================================================

// ============================================================================
// API HANDLER
// ============================================================================

/**
 * POST /api/documents/url
 *
 * Create a document from a URL.
 *
 * Request body:
 * - url: string (required) - The URL to process
 * - title: string (optional) - Override title
 * - description: string (optional) - Document description
 * - tags: string[] (optional) - Tags to apply
 *
 * Response:
 * - 201: Document created successfully
 * - 400: Invalid URL or request
 * - 403: The site reserved this content from text/data mining (TDM opt-out)
 * - 409: Duplicate URL exists
 * - 500: Server error
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    // Parse and validate request body
    const body = await request.json();
    const validation = urlInputSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid request', details: validation.error.flatten() }, { status: 400 });
    }

    const { url, title: overrideTitle, description, tags } = validation.data;

    // Validate URL format
    if (!isValidUrl(url)) {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    // Security validation
    const securityError = validateUrlSecurity(url);
    if (securityError) {
      return NextResponse.json({ error: securityError }, { status: 400 });
    }

    // Normalize URL and check for duplicates
    const normalized = normalizeUrl(url);
    const existing = await getDocumentByNormalizedUrl(url);

    if (existing) {
      return NextResponse.json(
        {
          error: 'A document with this URL already exists',
          existingId: existing.id,
          existingTitle: existing.title,
        },
        { status: 409 }
      );
    }

    // DSM Directive (EU) 2019/790 Art 4(3): respect machine-readable TDM
    // opt-outs BEFORE fetching. This has to precede the fetch, not follow it —
    // a rights check that runs after the copy has been made is not a gate.
    //
    // AUDIT-007: this check previously ran only on the scheduled refresh job,
    // so the background task honored the site's opt-out while the button the
    // user just pressed did not.
    const tdm = await checkTdmPolicy(url);
    if (!tdm.allowed) {
      log.info('URL ingestion refused by TDM policy', { url, reason: tdm.reason });
      return NextResponse.json({ error: tdm.reason ?? 'TDM opt-out', tdmBlocked: true }, { status: 403 });
    }

    // Fetch URL content (ARUN-022: Firecrawl provider call is receipted inside
    // the centralized helper under the document's owner + a stable id).
    const fetchResult = await fetchUrlContentReceipted(url, {
      owner: `user:${auth.uid}`,
      // Pre-allocated document id would be ideal, but the document is created
      // AFTER the fetch. Use the normalized URL hash so an exact re-ingest of
      // the same URL by the same owner is idempotent, not a duplicate receipt.
      correlationId: `url-ingest-${auth.uid}-${normalized}`,
    });

    if (!fetchResult.success) {
      return NextResponse.json({ error: fetchResult.error || 'Failed to fetch URL content' }, { status: 400 });
    }

    if (!fetchResult.content || fetchResult.content.trim().length === 0) {
      return NextResponse.json({ error: 'No content could be extracted from URL' }, { status: 400 });
    }

    const extractedContent = fetchResult.content;

    // Extract domain and determine title
    const domain = extractDomain(url);
    const documentTitle = overrideTitle || fetchResult.title || `Page from ${domain}`;

    // Create document record
    const document = await createDocument({
      title: documentTitle,
      type: 'url',
      storageUrl: '', // Will be populated after storage
      originalUrl: url,
      uploadedBy: auth.uid,
      description,
      tags,
    });

    // Update with URL-specific fields
    await updateDocument(document.id, {
      normalizedUrl: normalized,
      domain,
      version: 1,
    });

    // Trigger document processing (chunking, embeddings, etc.)
    // Try Inngest first, fall back to synchronous processing if it fails
    let processingStatus = 'processing';
    let chunkCount = 0;

    try {
      await inngest.send({
        name: 'app/document.process.requested',
        data: {
          documentId: document.id,
          content: extractedContent,
          options: {
            source: 'url',
          },
        },
      });
      log.info('Triggered async processing via Inngest', { documentId: document.id });
    } catch (_inngestError) {
      // Inngest failed (likely API key not configured), process synchronously
      log.warn('Inngest failed, processing synchronously');

      try {
        const result = await processDocumentFromContent(document.id, extractedContent, {
          replaceExisting: true,
        });

        if (result.success) {
          processingStatus = 'processed';
          chunkCount = result.chunkCount || 0;
          log.info('Processed document synchronously', { documentId: document.id, chunkCount });
        } else {
          processingStatus = 'failed';
          log.error('Synchronous processing failed', undefined, { error: result.error });
        }
      } catch (processError) {
        processingStatus = 'failed';
        log.error('Synchronous processing error', processError instanceof Error ? processError : undefined);
      }
    }

    log.info('Created document from URL', { documentId: document.id, domain });

    return NextResponse.json(
      {
        success: true,
        document: {
          id: document.id,
          title: document.title,
          domain,
          status: processingStatus,
          chunkCount: chunkCount > 0 ? chunkCount : undefined,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    log.error('Error processing URL', error instanceof Error ? error : undefined);

    return NextResponse.json(
      {
        error: 'Failed to process URL',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
