/**
 * @jest-environment node
 *
 * Covers the saveDiagram addition to the super-graph MCP server: it is advertised
 * in getTools() and callTool() delegates to executeSaveDiagram with the caller's
 * userId + designBrief (so a persisted diagram is owner-scoped, write-gated).
 */
const mockExecuteSaveDiagram = jest.fn();
const mockExecuteRenderDiagram = jest.fn();
const mockExecuteRenderRadarDiagram = jest.fn();
jest.mock('@/lib/ai/tools/super-graph-tools', () => ({
  executeSaveDiagram: (...a: unknown[]) => mockExecuteSaveDiagram(...a),
  executeRenderDiagram: (...a: unknown[]) => mockExecuteRenderDiagram(...a),
  executeRenderRadarDiagram: (...a: unknown[]) => mockExecuteRenderRadarDiagram(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { createSuperGraphServer } from '../super-graph-server';

describe('super-graph MCP server — saveDiagram', () => {
  const server = createSuperGraphServer();
  beforeEach(() => jest.clearAllMocks());

  it('advertises saveDiagram alongside the render tools', () => {
    const names = server.getTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['renderDiagram', 'renderRadarDiagram', 'saveDiagram']));
  });

  it('callTool(saveDiagram) delegates to executeSaveDiagram with the caller userId + designBrief', async () => {
    mockExecuteSaveDiagram.mockResolvedValue({ success: true, visualizationId: 'v1', url: '/infographics/v1' });

    const result = await server.callTool('saveDiagram', { kind: 'sankey', data: { nodes: [], links: [] } }, {
      userId: 'user-1',
      designBrief: undefined,
    } as never);

    expect(mockExecuteSaveDiagram).toHaveBeenCalledWith(
      { kind: 'sankey', data: { nodes: [], links: [] } },
      undefined,
      'user-1'
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('/infographics/v1');
  });

  it('callTool(saveDiagram) returns an error result when the executor reports failure', async () => {
    mockExecuteSaveDiagram.mockResolvedValue({ success: false, error: 'A userId is required to save a diagram.' });

    const result = await server.callTool('saveDiagram', { kind: 'sankey', data: {} }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('userId is required');
  });

  it('callTool rejects an unknown tool', async () => {
    const result = await server.callTool('nope_12345', {});
    expect(result.isError).toBe(true);
  });
});
