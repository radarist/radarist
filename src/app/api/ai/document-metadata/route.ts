/**
 * @file api/ai/document-metadata/route.ts
 * @description API endpoint for generating AI-suggested metadata for documents.
 * Uses the filename to generate a title, description, and tags.
 *
 * POST /api/ai/document-metadata
 * - Accepts { fileName: string }
 * - Returns { title, description, tags }
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-12
 */

import { NextRequest, NextResponse } from 'next/server';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { generateStructuredContent } from '@/lib/ai/client';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/ai/document-metadata');

// Input validation schema
const RequestSchema = z.object({
  fileName: z.string().min(1, 'fileName is required'),
});

// Output schema for AI response
const DocumentMetadataSchema = z.object({
  title: z.string().describe('A clean, human-readable title for the document'),
  description: z.string().describe('A brief description of what the document likely contains based on its name'),
  tags: z.string().describe('Comma-separated relevant tags for categorization'),
});

/**
 * Generate a fallback metadata from filename when AI fails
 */
function generateFallbackMetadata(fileName: string): z.infer<typeof DocumentMetadataSchema> {
  // Remove extension and clean up the name
  const cleanName = fileName
    .replace(/\.[^/.]+$/, '') // Remove extension
    .replace(/[-_]/g, ' ') // Replace dashes/underscores with spaces
    .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();

  // Capitalize first letter of each word
  const title = cleanName
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  // Generate basic tags from filename parts
  const words = cleanName.toLowerCase().split(' ').filter(w => w.length > 2);
  const tags = words.slice(0, 3).join(', ');

  return {
    title,
    description: '',
    tags,
  };
}

/**
 * POST handler for document metadata generation.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();

    // Validate input
    const validation = RequestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error.errors[0].message },
        { status: 400 }
      );
    }

    const { fileName } = validation.data;

    try {
      // Generate AI-powered metadata
      const prompt = `Given the filename "${fileName}", generate appropriate metadata for this document.

Consider:
- The title should be clean and human-readable (remove dates, IDs, extensions)
- The description should be a brief guess at what the document contains
- Tags should be relevant keywords for categorization (comma-separated)

Examples:
- "Q4-2024-Financial-Report.pdf" → Title: "Q4 2024 Financial Report", Description: "Quarterly financial report for the fourth quarter of 2024", Tags: "finance, quarterly report, 2024"
- "product_roadmap_v2.pptx" → Title: "Product Roadmap", Description: "Product roadmap presentation outlining future plans", Tags: "product, roadmap, planning"
- "meeting_notes_2024-01-15.docx" → Title: "Meeting Notes", Description: "Notes from a meeting held on January 15, 2024", Tags: "meeting, notes"`;

      const result = await generateStructuredContent(prompt, DocumentMetadataSchema, {
        model: geminiTextModel() as GeminiModel,
      });

      log.info('Generated metadata', { fileName });

      return NextResponse.json(result);
    } catch (aiError) {
      // AI failed, use fallback
      log.warn('AI generation failed, using fallback', { error: aiError instanceof Error ? aiError.message : String(aiError) });
      const fallback = generateFallbackMetadata(fileName);
      return NextResponse.json(fallback);
    }
  } catch (error) {
    log.error('Document metadata generation failed', error instanceof Error ? error : undefined);
    return NextResponse.json(
      { error: 'Failed to generate document metadata' },
      { status: 500 }
    );
  }
}
