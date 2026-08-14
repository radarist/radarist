import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH, MAX_VISUALIZATION_TITLE_LENGTH } from '@/lib/schemas/visualization';
import { describeDiagramKinds, DIAGRAM_KIND_IDS } from '@/lib/super-graph/kind-contract';

/**
 * Super-Graph tool: render publication-grade diagrams from the canonical catalog.
 *
 * Pass `kind: "auto"` to let the skill select the best chart for the given data
 * and intent. The implementation lives in `@/lib/super-graph/tool`; we keep the
 * AI-tool surface small and dynamic-import the heavy module so unrelated chats
 * never pay the Playwright/ECharts boot cost.
 */
export const SUPER_GRAPH_TOOLS: FunctionDeclaration[] = [
  {
    name: 'renderDiagram',
    description:
      'Render a publication-grade diagram (including tech radar, sankey, treemap, risk matrix, S-curve, labelled scatter/quadrant, roadmap timeline, gantt, flowchart, sequence, mindmap, bubble, and calendar heatmap) and return inline SVG. Pass kind="auto" to let the skill pick the best chart for your data and intent. A rejected call returns { success:false, error } naming the exact offending field and the required shape.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        kind: {
          // AI-050: enumerated from the same catalog that publishes the shapes,
          // so a kind can never be offered without a schema-validated payload.
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['auto', ...DIAGRAM_KIND_IDS],
          description: 'Specific kind id (e.g. tech-radar, sankey, treemap, …) or "auto" to pick automatically.',
        },
        data: {
          type: SchemaType.STRING,
          description:
            'Diagram data as a JSON-encoded string, in the shape published for the chosen kind. Each line below is a minimal VALID payload — copy it and replace the values:\n' +
            describeDiagramKinds(),
        },
        intent: {
          type: SchemaType.STRING,
          description:
            'Optional one-line description of the message you want the chart to convey (used by auto-select).',
        },
        title: { type: SchemaType.STRING },
        caption: { type: SchemaType.STRING },
      },
      required: ['kind', 'data'],
    },
  },
  {
    name: 'renderRadarDiagram',
    description:
      'Render a SPECIFIC radar as a publication-grade tech-radar SVG, built DIRECTLY from its graph placements (not hand-authored JSON). Use when the user asks to draw / render / visualize / show a picture of a radar. Pass radarId — resolve a radar name via listRadars first. Returns inline SVG with each technology placed by quadrant + ring; reports cleanly if the radar has no placements yet.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        radarId: {
          type: SchemaType.STRING,
          description: 'ID of the radar to render. If the user gives a name, resolve it via listRadars first.',
        },
      },
      required: ['radarId'],
    },
  },
  {
    name: 'saveDiagram',
    description:
      "Save a diagram to the user's Infographics gallery so it persists (a rendered diagram is otherwise only shown inline and lost when the chat scrolls away). Re-renders the diagram server-side and stores it as a visualization — call it after the user likes a renderDiagram/renderRadarDiagram preview, or directly when they ask to save/keep one. Provide EITHER the same kind+data you'd pass to renderDiagram, OR a radarId to save a specific radar. Returns the /infographics URL.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        kind: { type: SchemaType.STRING, description: 'Diagram kind (same as renderDiagram) — omit if using radarId.' },
        data: {
          type: SchemaType.STRING,
          description: 'JSON-encoded diagram data (same as renderDiagram) — omit if using radarId.',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'Save a specific radar as a tech-radar diagram (mutually exclusive with kind+data).',
        },
        title: { type: SchemaType.STRING, description: 'Title for the saved gallery item.' },
        intent: { type: SchemaType.STRING, description: 'Optional one-line description (used as the prompt/label).' },
        caption: { type: SchemaType.STRING },
      },
      required: [],
    },
  },
];

/**
 * AI-050 — the tool result declares `error` BEFORE `svg`.
 *
 * A failed render still returns a full-size placeholder SVG, and the persisted
 * agent-event receipt is length-bounded. With the reason behind multi-KB of
 * fallback markup, a rejected call left `success:false` as its only durable
 * trace. `JSON.stringify` preserves insertion order, so leading with the reason
 * keeps the diagnosis readable after truncation.
 */
export async function executeRenderDiagram(
  args: Record<string, unknown>,
  brief?: import('@/lib/schemas/design-brief').DesignBrief
): Promise<{ success: boolean; kind: string; error?: string; rationale?: string; svg: string }> {
  const { renderDiagram } = await import('@/lib/super-graph/tool');
  const { chartTokensForBrief } = await import('@/lib/super-graph/design-tokens');

  // The Gemini function-calling schema doesn't support free-form objects, so
  // we accept `data` as either a JSON string or a parsed object (callers from
  // unit tests can pass an object directly; the LLM will pass a JSON string).
  let data: unknown = args.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return {
        success: false,
        kind: typeof args.kind === 'string' ? args.kind : 'unknown',
        error: `Invalid JSON in 'data' argument: ${(err as Error).message}`,
        svg: '',
      };
    }
  }

  const result = await renderDiagram({
    kind: args.kind as string,
    data,
    intent: args.intent as string | undefined,
    title: args.title as string | undefined,
    caption: args.caption as string | undefined,
    // Brand theme from the mission's DesignBrief (chat mode → undefined →
    // lightEditorial default, unchanged).
    tokens: chartTokensForBrief(brief),
  });
  return {
    success: result.success,
    kind: result.kind,
    error: result.error,
    rationale: result.rationale,
    svg: result.svg,
  };
}

/**
 * Render a specific radar as a tech-radar diagram, built deterministically from
 * its graph placements (backlog 3.5). Fetches the radar config + placed
 * technologies via the server-safe admin helpers, maps them with the pure
 * `buildRadarDiagramPayload` adapter, then reuses `executeRenderDiagram` for
 * the SVG — so the chart is data-bound, not LLM-transcribed.
 */
export async function executeRenderRadarDiagram(
  args: Record<string, unknown>,
  brief?: import('@/lib/schemas/design-brief').DesignBrief
): Promise<{ success: boolean; kind: string; error?: string; rationale?: string; svg: string }> {
  const radarId = typeof args.radarId === 'string' ? args.radarId.trim() : '';
  if (!radarId) {
    return { success: false, kind: 'tech-radar', error: 'radarId is required', svg: '' };
  }
  try {
    // Admin SDK — client-SDK reads from the /api/ai/chat route surface an
    // "internal Firestore error" (same failure mode the radar-management tools hit).
    const { adminGetRadarById, adminGetTechnologiesWithPlacementsForRadar } = await import('@/lib/radars-admin');
    const radar = await adminGetRadarById(radarId);
    if (!radar) {
      return { success: false, kind: 'tech-radar', error: `Radar ${radarId} not found.`, svg: '' };
    }
    const technologies = await adminGetTechnologiesWithPlacementsForRadar(radarId);
    if (technologies.length === 0) {
      return {
        success: false,
        kind: 'tech-radar',
        error: `Radar "${radar.name}" has no placed technologies to render yet.`,
        svg: '',
      };
    }
    const { buildRadarDiagramPayload } = await import('@/lib/super-graph/radar-adapter');
    const { payload, itemCount, truncated } = buildRadarDiagramPayload(radar, technologies);
    const result = await executeRenderDiagram({ kind: 'tech-radar', data: payload, title: radar.name }, brief);
    if (!result.success) return result;
    return {
      ...result,
      rationale: `Rendered "${radar.name}" from the graph: ${itemCount} technolog${itemCount === 1 ? 'y' : 'ies'} across ${payload.quadrants.length} quadrant${payload.quadrants.length === 1 ? '' : 's'}${truncated ? ' (capped at 120)' : ''}.`,
    };
  } catch (error) {
    return {
      success: false,
      kind: 'tech-radar',
      error: `Failed to render radar diagram: ${error instanceof Error ? error.message : 'Unknown error'}`,
      svg: '',
    };
  }
}

/**
 * Persist a rendered diagram into the Infographics gallery (the `visualizations`
 * collection) so it survives past the chat bubble. The chat route strips the SVG
 * from the model-facing tool result, so we cannot accept an SVG argument — we
 * REPRODUCE it deterministically from the same spec (kind+data, or radarId), then
 * upload the vector SVG and store it as a visualization. Write-scoped (owner =
 * caller); not reachable by a read-only key.
 */
export async function executeSaveDiagram(
  args: Record<string, unknown>,
  brief?: import('@/lib/schemas/design-brief').DesignBrief,
  userId?: string
): Promise<{ success: boolean; visualizationId?: string; url?: string; kind?: string; error?: string }> {
  if (!userId) {
    return { success: false, error: 'A userId is required to save a diagram.' };
  }

  const radarId = typeof args.radarId === 'string' ? args.radarId.trim() : '';
  const rendered = radarId
    ? await executeRenderRadarDiagram({ radarId }, brief)
    : await executeRenderDiagram(args, brief);
  if (!rendered.success || !rendered.svg) {
    return { success: false, kind: rendered.kind, error: rendered.error ?? 'Diagram render failed.' };
  }

  // Clamp to the visualization schema bounds (title ≤ 200, dataSnapshot
  // description ≤ 1000) so an over-long model-authored title/rationale can
  // never fail the save of an already-rendered diagram.
  const rawTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : `${rendered.kind} diagram`;
  const title = rawTitle.slice(0, MAX_VISUALIZATION_TITLE_LENGTH);
  const promptText = typeof args.intent === 'string' && args.intent.trim() ? args.intent.trim() : title;
  const storageObjectName = `super-graph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const storageObjectPath = `visualizations/${userId}/${storageObjectName}`;

  try {
    const svgBytes = Buffer.from(rendered.svg, 'utf-8');
    const { assertVisualizationExportPayload } = await import('@/lib/visualization-export-validation');
    // Persistence is not success unless the exact bytes are a well-formed,
    // static, provenance-bound SVG that the browser/export path can decode.
    // Validate before either Storage or Firestore is mutated.
    assertVisualizationExportPayload(svgBytes, 'image/svg+xml', 'image/svg+xml');

    const { uploadImage } = await import('@/lib/storage');
    // Upload under the 'visualizations/' prefix — it is one of the three storage
    // paths allow-listed in storage.rules (documents/infographics/visualizations);
    // any other prefix (e.g. 'diagrams/') hits the default `allow write: if false`
    // and the write is denied. A saved diagram IS a visualization, so this is the
    // correct home, and it matches the collection it lands in.
    const imageUrl = await uploadImage(svgBytes, userId, 'image/svg+xml', 'visualizations', storageObjectName);

    const { createVisualization } = await import('@/lib/visualizations');
    const viz = await createVisualization({
      title,
      prompt: promptText,
      refinedPrompt: promptText,
      imageUrl,
      thumbnailUrl: imageUrl, // vector SVG scales — the image is its own thumbnail
      storageObjectPath,
      mimeType: 'image/svg+xml',
      style: 'professional',
      dataSnapshot: {
        entities: [],
        description: (rendered.rationale ?? `${rendered.kind} diagram`).slice(
          0,
          MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH
        ),
      },
      userId,
      createdBy: userId,
      metadata: { model: 'super-graph', width: 0, height: 0, sizeBytes: Buffer.byteLength(rendered.svg, 'utf-8') },
    });
    return { success: true, visualizationId: viz.id, url: `/infographics/${viz.id}`, kind: rendered.kind };
  } catch (error) {
    return {
      success: false,
      kind: rendered.kind,
      error: `Failed to save diagram: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
