/**
 * @file route.ts
 * @description API endpoint to analyze document content and generate metadata using AI.
 *
 * Uses Gemini to analyze document text and generate:
 * - A concise description (1-2 sentences)
 * - Relevant tags (3-8 tags)
 *
 * @author Radarist Team
 * @created 2026-01-19
 */

import { NextRequest, NextResponse } from "next/server";
import type { GeminiModel } from "@/lib/ai/client";
import { geminiTextModel } from "@/lib/ai/model-config";
import { z } from "zod";
import { generateStructuredContent } from "@/lib/ai/client";
import { getAuthenticatedUser } from "@/lib/auth-utils";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/ai/analyze-document");

// ============================================================================
// Request Validation Schema
// ============================================================================

const analyzeRequestSchema = z.object({
  text: z.string().min(100, "Text too short to analyze").max(100000, "Text too large"),
  fileName: z.string().min(1, "File name required"),
  fileType: z.string().optional(),
});

// ============================================================================
// Response Schema for Gemini
// ============================================================================

const DocumentMetadataSchema = z.object({
  description: z.string().describe("A concise 1-2 sentence description of the document's main content and purpose"),
  tags: z.array(z.string()).describe("3-8 relevant tags for categorizing this document. Use lowercase, hyphenated format (e.g., 'market-analysis', 'strategic-planning')"),
  documentType: z.string().describe("The type of document (e.g., 'report', 'roadmap', 'analysis', 'presentation', 'memo', 'proposal')"),
  keyTopics: z.array(z.string()).describe("2-5 main topics or themes covered in the document"),
});

// ============================================================================
// API Handler
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    // Parse and validate request body
    const body = await request.json();
    const validationResult = analyzeRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request format",
          details: validationResult.error.errors,
        },
        { status: 400 }
      );
    }

    const { text, fileName, fileType } = validationResult.data;

    // Truncate text if too long (keep first 15000 chars for analysis)
    const analysisText = text.length > 15000 ? text.slice(0, 15000) + "\n\n[Content truncated for analysis...]" : text;

    // Build the prompt with explicit JSON output instructions
    const prompt = `Analyze this document and generate metadata for it. You MUST respond with a valid JSON object.

**File Name:** ${fileName}
${fileType ? `**File Type:** ${fileType}` : ""}

**Document Content:**
${analysisText}

---

Analyze the document above and return a JSON object with these exact fields:

{
  "description": "A concise 1-2 sentence description of the document's main content and purpose",
  "tags": ["tag1", "tag2", "tag3"],
  "documentType": "report|roadmap|analysis|presentation|memo|proposal|specification|other",
  "keyTopics": ["topic1", "topic2", "topic3"]
}

Requirements:
- description: 1-2 sentences summarizing what the document is about
- tags: 4-6 lowercase hyphenated tags (e.g., "market-analysis", "ai-ml", "digital-transformation")
  - Include industry-specific tags if applicable (e.g., "chemical-industry", "food-tech")
  - Include document purpose tags (e.g., "roadmap", "competitor-analysis")
  - Include technology tags if relevant
- documentType: One of: report, roadmap, analysis, presentation, memo, proposal, specification, or other
- keyTopics: 2-5 main topics or themes covered in the document

Respond ONLY with the JSON object, no additional text or explanation.`;

    // Use structured output with Gemini
    const metadata = await generateStructuredContent(prompt, DocumentMetadataSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    // Clean up tags
    const cleanedTags = metadata.tags
      .map((tag) => tag.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""))
      .filter((tag) => tag.length > 1)
      .slice(0, 8);

    // Always include 'ai-upload' tag
    if (!cleanedTags.includes("ai-upload")) {
      cleanedTags.push("ai-upload");
    }

    return NextResponse.json({
      success: true,
      description: metadata.description,
      tags: cleanedTags,
      documentType: metadata.documentType,
      keyTopics: metadata.keyTopics,
    });
  } catch (error) {
    log.error("Document analysis failed", error instanceof Error ? error : undefined);

    // Return fallback metadata on error
    return NextResponse.json({
      success: true,
      description: "Document uploaded via AI Assistant",
      tags: ["ai-upload"],
      documentType: "document",
      keyTopics: [],
      error: error instanceof Error ? error.message : "Analysis failed, using defaults",
    });
  }
}
