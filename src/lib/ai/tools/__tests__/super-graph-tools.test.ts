/**
 * @jest-environment node
 */
const mockRenderDiagram = jest.fn();
jest.mock('@/lib/super-graph/tool', () => ({ renderDiagram: (...a: unknown[]) => mockRenderDiagram(...a) }));
jest.mock('@/lib/super-graph/design-tokens', () => ({ chartTokensForBrief: () => ({}) }));

const mockUploadImage = jest.fn();
jest.mock('@/lib/storage', () => ({ uploadImage: (...a: unknown[]) => mockUploadImage(...a) }));

const mockCreateVisualization = jest.fn();
jest.mock('@/lib/visualizations', () => ({ createVisualization: (...a: unknown[]) => mockCreateVisualization(...a) }));

const mockGetRadar = jest.fn();
const mockGetTechs = jest.fn();
jest.mock('@/lib/radars-admin', () => ({
  adminGetRadarById: (...a: unknown[]) => mockGetRadar(...a),
  adminGetTechnologiesWithPlacementsForRadar: (...a: unknown[]) => mockGetTechs(...a),
}));
jest.mock('@/lib/super-graph/radar-adapter', () => ({
  buildRadarDiagramPayload: () => ({
    payload: { quadrants: [{}], rings: [], items: [] },
    itemCount: 1,
    truncated: false,
  }),
}));

const { markSuperGraphSvg } = require('@/lib/super-graph/provenance');
const { executeSaveDiagram } = require('../super-graph-tools');

describe('executeSaveDiagram', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders, uploads the SVG as image/svg+xml, saves a visualization, returns the /infographics url', async () => {
    mockRenderDiagram.mockResolvedValue({
      success: true,
      svg: markSuperGraphSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>flow</text></svg>'),
      kind: 'sankey',
      rationale: 'the flow',
    });
    mockUploadImage.mockResolvedValue('https://storage/diagrams/u1/x.svg');
    mockCreateVisualization.mockResolvedValue({ id: 'viz-1' });

    const result = await executeSaveDiagram(
      { kind: 'sankey', data: '{"nodes":[],"links":[]}', title: 'Auth Flow' },
      undefined,
      'user-1'
    );

    // uploaded as a vector SVG under the visualizations/ prefix (an allow-listed
    // storage path — a saved diagram IS a visualization), owned by the caller
    expect(mockUploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'user-1',
      'image/svg+xml',
      'visualizations',
      expect.stringMatching(/^super-graph-[a-z0-9]+-[a-z0-9]+$/)
    );
    const storageObjectName = mockUploadImage.mock.calls[0][4];
    expect(storageObjectName).not.toContain('.svg');
    // persisted as a visualization so it lands in /infographics
    expect(mockCreateVisualization).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Auth Flow',
        imageUrl: 'https://storage/diagrams/u1/x.svg',
        thumbnailUrl: 'https://storage/diagrams/u1/x.svg',
        storageObjectPath: `visualizations/user-1/${storageObjectName}`,
        mimeType: 'image/svg+xml',
        userId: 'user-1',
        createdBy: 'user-1',
      })
    );
    expect(result).toEqual(
      expect.objectContaining({ success: true, visualizationId: 'viz-1', url: '/infographics/viz-1', kind: 'sankey' })
    );
  });

  it('clamps an oversized rationale and title to the visualization contract bounds', async () => {
    mockRenderDiagram.mockResolvedValue({
      success: true,
      svg: markSuperGraphSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>flow</text></svg>'),
      kind: 'sankey',
      rationale: 'r'.repeat(1500),
    });
    mockUploadImage.mockResolvedValue('https://storage/diagrams/u1/x.svg');
    mockCreateVisualization.mockResolvedValue({ id: 'viz-1' });

    const result = await executeSaveDiagram(
      { kind: 'sankey', data: '{"nodes":[],"links":[]}', title: 't'.repeat(300) },
      undefined,
      'user-1'
    );

    expect(result.success).toBe(true);
    const created = mockCreateVisualization.mock.calls[0][0];
    expect(created.dataSnapshot.description).toHaveLength(1000);
    expect(created.title).toHaveLength(200);
  });

  it('requires a userId (no render, no write)', async () => {
    const result = await executeSaveDiagram({ kind: 'sankey', data: '{}' }, undefined, undefined);
    expect(result.success).toBe(false);
    expect(mockRenderDiagram).not.toHaveBeenCalled();
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('propagates a render failure without uploading or persisting', async () => {
    mockRenderDiagram.mockResolvedValue({ success: false, svg: '', kind: 'sankey', error: 'invalid data' });

    const result = await executeSaveDiagram({ kind: 'sankey', data: '{}' }, undefined, 'user-1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid data/);
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(mockCreateVisualization).not.toHaveBeenCalled();
  });

  it('saves a radar diagram when given a radarId (renders from graph placements)', async () => {
    mockGetRadar.mockResolvedValue({ id: 'r1', name: 'Cloud Radar' });
    mockGetTechs.mockResolvedValue([{ id: 't1' }]);
    mockRenderDiagram.mockResolvedValue({
      success: true,
      svg: markSuperGraphSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>radar</text></svg>'),
      kind: 'tech-radar',
    });
    mockUploadImage.mockResolvedValue('https://storage/diagrams/u1/radar.svg');
    mockCreateVisualization.mockResolvedValue({ id: 'viz-radar' });

    const result = await executeSaveDiagram({ radarId: 'r1' }, undefined, 'user-1');

    expect(mockGetRadar).toHaveBeenCalledWith('r1');
    expect(mockCreateVisualization).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/svg+xml' }));
    expect(result).toEqual(expect.objectContaining({ success: true, visualizationId: 'viz-radar' }));
  });

  it('rejects malformed rendered SVG before Storage or Firestore mutation', async () => {
    mockRenderDiagram.mockResolvedValue({
      success: true,
      svg: markSuperGraphSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Inter, "Inter Display"">radar</text></svg>'
      ),
      kind: 'tech-radar',
    });

    const result = await executeSaveDiagram(
      { kind: 'tech-radar', data: '{"quadrants":[],"rings":[],"items":[]}' },
      undefined,
      'user-1'
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        kind: 'tech-radar',
        error: expect.stringMatching(/well-formed SVG document/i),
      })
    );
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(mockCreateVisualization).not.toHaveBeenCalled();
  });

  it('claims no durable artifact when the rendered SVG is rejected', async () => {
    // UX-066 — not writing is only half the contract. A caller (or an agent
    // relaying to an operator) must not be handed an id, a URL, or a detail
    // link that implies something was retained, because nothing was.
    mockRenderDiagram.mockResolvedValue({
      success: true,
      svg: markSuperGraphSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Inter, "Inter Display"">radar</text></svg>'
      ),
      kind: 'tech-radar',
    });

    const result = (await executeSaveDiagram(
      { kind: 'tech-radar', data: '{"quadrants":[],"rings":[],"items":[]}' },
      undefined,
      'user-1'
    )) as Record<string, unknown>;

    expect(result.success).toBe(false);
    for (const durableField of ['visualizationId', 'imageUrl', 'thumbnailUrl', 'storageObjectPath', 'url']) {
      expect(result[durableField]).toBeUndefined();
    }
    // Nothing anywhere in the payload may read as a persisted infographic link.
    expect(JSON.stringify(result)).not.toContain('/infographics/');
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(mockCreateVisualization).not.toHaveBeenCalled();
  });
});
