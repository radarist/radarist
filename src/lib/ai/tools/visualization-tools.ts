/**
 * @file ai/tools/visualization-tools.ts
 * @description AI tools for image generation using Nano Banana.
 *
 * Two tools:
 * - generateInfographic: Lighter tool for Creator agent (embedded in reports, no Firestore save)
 * - generateVisualization: Richer tool for AI Assistant (saves to Firestore visualizations collection)
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { createLogger } from '@/lib/logger';
import { geminiImageModel } from '@/lib/ai/model-config';
import {
  MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH,
  MAX_VISUALIZATION_ENTITY_NAME_LENGTH,
  MAX_VISUALIZATION_ENTITY_REFS,
  MAX_VISUALIZATION_TITLE_LENGTH,
  VISUALIZATION_ENTITY_TYPES,
  visualizationEntityRefInputSchema,
  type VisualizationEntityRefInput,
  type VisualizationEntitySnapshot,
  type VisualizationEntityType,
} from '@/lib/schemas/visualization';

const log = createLogger('ai/tools/visualization-tools');

/**
 * Validate and merge the caller's entity references (typed `entityRefs` and
 * legacy untyped `entityIds`) into one deduplicated, bounded list. Any
 * malformed reference rejects the whole request — this runs BEFORE the paid
 * image generation call, so bad input never spends an image.
 */
function parseVisualizationEntityRefs(
  args: Record<string, unknown>
): { refs: VisualizationEntityRefInput[] } | { error: string } {
  const merged = new Map<string, VisualizationEntityRefInput>();

  const addRef = (candidate: unknown, label: string): string | null => {
    const parsed = visualizationEntityRefInputSchema.safeParse(candidate);
    if (!parsed.success) {
      return `${label} is invalid: ${parsed.error.issues[0]?.message ?? 'malformed entity reference'}`;
    }
    const existing = merged.get(parsed.data.id);
    if (!existing) {
      merged.set(parsed.data.id, parsed.data);
      return null;
    }
    if (existing.type && parsed.data.type && existing.type !== parsed.data.type) {
      return `Entity reference "${parsed.data.id}" is ambiguous: claimed as both ${existing.type} and ${parsed.data.type}`;
    }
    if (!existing.type && parsed.data.type) {
      merged.set(parsed.data.id, parsed.data);
    }
    return null;
  };

  const rawRefs = args.entityRefs;
  if (rawRefs !== undefined) {
    if (!Array.isArray(rawRefs)) return { error: 'entityRefs must be an array of {id, type} references' };
    for (const [index, candidate] of rawRefs.entries()) {
      const error = addRef(candidate, `entityRefs[${index}]`);
      if (error) return { error };
    }
  }

  const rawIds = args.entityIds;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds)) return { error: 'entityIds must be an array of entity id strings' };
    for (const [index, candidate] of rawIds.entries()) {
      const error = addRef({ id: candidate }, `entityIds[${index}]`);
      if (error) return { error };
    }
  }

  if (merged.size > MAX_VISUALIZATION_ENTITY_REFS) {
    return { error: `generateVisualization accepts at most ${MAX_VISUALIZATION_ENTITY_REFS} unique entity references` };
  }

  return { refs: [...merged.values()] };
}

/**
 * Capture the persisted {id, name, type} snapshots for validated references.
 * Resolution order: current typed Firestore name → graph node (name + label
 * type) → exact-ID fallback keeping the claimed type ('unknown' when untyped).
 * Every step is fail-open: a visualization must still save during Firestore or
 * graph degradation — readers then self-heal typed refs from live data later.
 */
async function captureVisualizationEntitySnapshots(
  refs: VisualizationEntityRefInput[]
): Promise<VisualizationEntitySnapshot[]> {
  if (refs.length === 0) return [];

  const resolved = new Map<string, { name: string; type: VisualizationEntityType }>();

  const typedRefs = refs.filter((ref): ref is { id: string; type: VisualizationEntityType } => ref.type !== undefined);
  if (typedRefs.length > 0) {
    try {
      const { fetchLiveVisualizationEntityNames } = await import('@/lib/visualization-entity-refs');
      const liveNames = await fetchLiveVisualizationEntityNames(typedRefs);
      for (const ref of typedRefs) {
        const name = liveNames.get(`${ref.type}:${ref.id}`);
        if (name) resolved.set(ref.id, { name, type: ref.type });
      }
    } catch (error) {
      log.warn('typed Firestore entity capture failed — trying graph', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const unresolvedIds = refs.filter((ref) => !resolved.has(ref.id)).map((ref) => ref.id);
  if (unresolvedIds.length > 0) {
    try {
      const [{ getEntities }, { getEntityTypeFromGraphLabels }] = await Promise.all([
        import('@/lib/graph/traversal'),
        import('@/lib/entity-links'),
      ]);
      const nodes = await getEntities(unresolvedIds);
      const requestedIds = new Set(unresolvedIds);

      for (const node of nodes) {
        if (!requestedIds.has(node.id)) continue;
        const type = getEntityTypeFromGraphLabels(node.labels);
        if (!type || !(VISUALIZATION_ENTITY_TYPES as readonly string[]).includes(type)) continue;
        const rawName = node.properties.name ?? node.properties.title;
        const name = typeof rawName === 'string' ? rawName.trim().slice(0, MAX_VISUALIZATION_ENTITY_NAME_LENGTH) : '';
        if (!name) continue;
        resolved.set(node.id, { name, type: type as VisualizationEntityType });
      }
    } catch (error) {
      log.warn('graph entity capture failed — saving exact-ID fallbacks', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return refs.map((ref) => {
    const hit = resolved.get(ref.id);
    if (hit) return { id: ref.id, name: hit.name, type: hit.type };
    return { id: ref.id, name: '', type: ref.type ?? 'unknown' };
  });
}

/**
 * Fail-open lookup of the learned-style fragment (US-1 — the like/dislike loop).
 * Never throws: a broken lookup logs a warning and generation proceeds unstyled.
 */
async function safeLearnedStyleFragment(): Promise<string | undefined> {
  try {
    const { buildLearnedStyleFragment } = await import('@/lib/visualizations');
    return await buildLearnedStyleFragment();
  } catch (error) {
    log.warn('learned-style fragment lookup failed — generating without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

// ============================================================================
// TOOL DECLARATIONS
// ============================================================================

export const VISUALIZATION_TOOLS: FunctionDeclaration[] = [
  {
    name: 'generateInfographic',
    description:
      "Generate a visual infographic from data using Nano Banana AI. Returns an image URL that can be embedded in HTML reports. Only visualizes provided data — never invents statistics. If the user attached an image, it is provided to this tool as a visual style/layout reference — reproduce its layout, palette, and typography and render the user's data in that style. Render only data the user provided; never invent numbers.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        prompt: {
          type: SchemaType.STRING,
          description: 'Detailed prompt including real data values to visualize',
        },
        style: {
          type: SchemaType.STRING,
          description: 'Visual style: professional, minimal, colorful, or dark',
        },
        aspectRatio: {
          type: SchemaType.STRING,
          description: 'Image aspect ratio: 1:1, 16:9, 4:3, or 9:16',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generateVisualization',
    description:
      "Generate a visual infographic and save it to the Visualizations collection. Always validate data with the user before calling this tool. The image is saved to Firebase Storage and browseable at /visualizations. If the user attached an image, it is provided to this tool as a visual style/layout reference — reproduce its layout, palette, and typography and render the user's data in that style. Render only data the user provided; never invent numbers.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        prompt: {
          type: SchemaType.STRING,
          description: 'Detailed prompt including real data values to visualize',
        },
        title: {
          type: SchemaType.STRING,
          description: 'Display title for the visualization',
        },
        style: {
          type: SchemaType.STRING,
          description: 'Visual style: professional, minimal, colorful, or dark',
        },
        aspectRatio: {
          type: SchemaType.STRING,
          description: 'Image aspect ratio: 1:1, 16:9, 4:3, or 9:16',
        },
        entityRefs: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: {
                type: SchemaType.STRING,
                description: 'Exact entity document id (from searchEntities/listEntities results)',
              },
              type: {
                type: SchemaType.STRING,
                description: `Entity type, one of: ${VISUALIZATION_ENTITY_TYPES.join(', ')}`,
              },
            },
            required: ['id'],
          },
          maxItems: MAX_VISUALIZATION_ENTITY_REFS,
          description:
            'Preferred: typed references to the entities whose data was used, e.g. [{"id": "tech-1", "type": "technology"}]. Pass the type you already know from entity lookups so the saved reference stays resolvable. Max 50 unique references.',
        },
        entityIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          maxItems: MAX_VISUALIZATION_ENTITY_REFS,
          description: 'Legacy untyped variant of entityRefs: bare entity ids. Prefer entityRefs with types.',
        },
        dataDescription: {
          type: SchemaType.STRING,
          description: 'Human-readable summary of what data is being visualized (max 1000 characters)',
        },
      },
      required: ['prompt', 'title', 'style', 'aspectRatio', 'dataDescription'],
    },
  },
];

// ============================================================================
// TOOL EXECUTORS
// ============================================================================

export async function executeGenerateInfographic(
  args: Record<string, unknown>,
  userId?: string,
  referenceImage?: { data: string; mimeType: string }
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  const { generateInfographic } = await import('@/lib/ai/image-client');
  const learnedStyleFragment = await safeLearnedStyleFragment();

  const result = await generateInfographic({
    prompt: args.prompt as string,
    style: (args.style as 'professional' | 'minimal' | 'colorful' | 'dark') ?? 'professional',
    aspectRatio: (args.aspectRatio as '1:1' | '16:9' | '4:3' | '9:16') ?? '16:9',
    userId: userId ?? 'system',
    pathPrefix: 'infographics',
    referenceImage,
    brandStyle: learnedStyleFragment,
  });

  if (!result.success) {
    return { success: false, error: result.error ?? 'Image generation failed' };
  }

  return { success: true, imageUrl: result.url! };
}

export async function executeGenerateVisualization(
  args: Record<string, unknown>,
  userId?: string,
  referenceImage?: { data: string; mimeType: string }
): Promise<{
  success: boolean;
  visualizationId?: string;
  imageUrl?: string;
  url?: string;
  error?: string;
}> {
  if (!userId) {
    return { success: false, error: 'generateVisualization requires an authenticated user context' };
  }

  // Bounded-contract validation. Everything here runs BEFORE the paid image
  // generation call: malformed input must never spend an image.
  const parsedRefs = parseVisualizationEntityRefs(args);
  if ('error' in parsedRefs) {
    return { success: false, error: parsedRefs.error };
  }
  if (
    typeof args.title !== 'string' ||
    args.title.trim().length === 0 ||
    args.title.length > MAX_VISUALIZATION_TITLE_LENGTH
  ) {
    return { success: false, error: `title must be 1–${MAX_VISUALIZATION_TITLE_LENGTH} characters` };
  }
  const dataDescription = args.dataDescription === undefined ? '' : args.dataDescription;
  if (typeof dataDescription !== 'string' || dataDescription.length > MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH) {
    return {
      success: false,
      error: `dataDescription must be a string of at most ${MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH} characters`,
    };
  }

  const { generateInfographic } = await import('@/lib/ai/image-client');
  const learnedStyleFragment = await safeLearnedStyleFragment();

  const storageObjectId = `visualization-asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const storageObjectPath = `visualizations/${userId}/${storageObjectId}`;

  // Generate full-size image
  const result = await generateInfographic({
    prompt: args.prompt as string,
    style: (args.style as 'professional' | 'minimal' | 'colorful' | 'dark') ?? 'professional',
    aspectRatio: (args.aspectRatio as '1:1' | '16:9' | '4:3' | '9:16') ?? '16:9',
    userId,
    pathPrefix: 'visualizations',
    // The content type is only known after generation, so this object identity
    // is deliberately extensionless. Export filenames use the persisted MIME.
    filename: storageObjectId,
    referenceImage,
    brandStyle: learnedStyleFragment,
  });

  if (!result.success || !result.url) {
    return { success: false, error: result.error ?? 'Image generation failed' };
  }

  if (result.mimeType !== 'image/png' && result.mimeType !== 'image/jpeg') {
    try {
      const { deleteStoredImage } = await import('@/lib/storage');
      await deleteStoredImage(storageObjectPath);
    } catch (cleanupError) {
      log.warn('failed to clean up visualization with unsupported media type', {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    return {
      success: false,
      error: `Image generation returned unsupported media type: ${result.mimeType ?? 'unknown'}`,
    };
  }

  // Save to Firestore visualizations collection
  try {
    const { createVisualization } = await import('@/lib/visualizations');
    const entities = await captureVisualizationEntitySnapshots(parsedRefs.refs);

    const visualization = await createVisualization({
      title: args.title,
      prompt: args.prompt as string,
      refinedPrompt: args.prompt as string,
      imageUrl: result.url!,
      thumbnailUrl: result.url!, // TODO: Generate actual thumbnail
      storageObjectPath,
      mimeType: result.mimeType,
      style: (args.style as 'professional' | 'minimal' | 'colorful' | 'dark') ?? 'professional',
      dataSnapshot: {
        entities,
        description: dataDescription,
      },
      userId,
      createdBy: userId || 'ai-assistant',
      metadata: {
        model: geminiImageModel(),
        width: result.width ?? 0,
        height: result.height ?? 0,
        sizeBytes: result.sizeBytes ?? 0,
      },
      ...(learnedStyleFragment ? { appliedStyleFragment: learnedStyleFragment } : {}),
    });

    return {
      success: true,
      visualizationId: visualization.id,
      imageUrl: result.url,
      url: `/infographics/${visualization.id}`,
    };
  } catch (error) {
    try {
      const { deleteStoredImage } = await import('@/lib/storage');
      await deleteStoredImage(storageObjectPath);
    } catch (cleanupError) {
      log.warn('failed to clean up unpersisted visualization image', {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    return {
      success: false,
      error: `Image generated but save failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
