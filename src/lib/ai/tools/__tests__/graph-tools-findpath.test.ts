/**
 * @file graph-tools-findpath.test.ts
 * @description Behaviour tests for executeFindGraphPath — verifies the
 * four status codes the chat relies on: entity_not_found / no_path /
 * path_found / error.
 */

jest.mock('@/lib/graph/resolve-entity', () => ({
  resolveEntityByIdOrName: jest.fn(),
}));
jest.mock('@/lib/graph', () => ({
  // Stable stubs for every export graph-tools.ts imports at module load.
  findPath: jest.fn(),
  findAllPaths: jest.fn(),
  findConnected: jest.fn(),
  getNeighbors: jest.fn(),
  checkConnection: jest.fn(),
  explainGraphConnection: jest.fn(),
  getGraphStatus: jest.fn(),
  formatPath: jest.fn(),
  findSolutionsForPainPoint: jest.fn(),
  findTechnologiesForStrategy: jest.fn(),
  analyzeTechnologyImpact: jest.fn(),
  findVendorsForStrategy: jest.fn(),
  analyzeGaps: jest.fn(),
  compareTechnologyPortfolio: jest.fn(),
  recommendTechnologyInvestments: jest.fn(),
  generateTechnologySummary: jest.fn(),
  executeNaturalLanguageQuery: jest.fn(),
  getExampleQueries: jest.fn(),
  getGraphService: jest.fn(),
  // AI-026: NOT stubbed — the reported entity type must come from the real
  // canonical-label derivation, not a mock's opinion.
  businessEntityGraphType: jest.requireActual('@/lib/graph/business-entity-identity')
    .businessEntityGraphType,
}));

import * as resolver from '@/lib/graph/resolve-entity';
import * as graphFns from '@/lib/graph';
import { executeFindGraphPath } from '../graph-tools';

const mockResolve = resolver.resolveEntityByIdOrName as jest.Mock;
const mockExplain = graphFns.explainGraphConnection as jest.Mock;
const mockFindPath = graphFns.findPath as jest.Mock;
const mockFindAll = graphFns.findAllPaths as jest.Mock;

describe('executeFindGraphPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns status=entity_not_found with suggestions when from-side misses', async () => {
    mockResolve.mockResolvedValueOnce({
      input: 'Nvidia',
      match: null,
      suggestions: [{ id: 'company-nvidia', name: 'Nvidia Corp', type: 'Company' }],
    });
    mockResolve.mockResolvedValueOnce({
      input: 'LangChain',
      match: { id: 'tech-1', name: 'LangChain', type: 'Technology' },
      suggestions: [],
    });

    const r = await executeFindGraphPath({ fromId: 'Nvidia', toId: 'LangChain' });

    expect(r.status).toBe('entity_not_found');
    expect(r.missing).toHaveLength(1);
    expect(r.missing![0]).toMatchObject({ slot: 'from', input: 'Nvidia' });
    expect(r.missing![0].suggestions[0].name).toBe('Nvidia Corp');
    expect(mockExplain).not.toHaveBeenCalled();
  });

  it('returns status=no_path when both resolve but graph is disconnected', async () => {
    mockResolve.mockResolvedValueOnce({
      input: 'tech-1',
      match: { id: 'tech-1', name: 'LangChain', type: 'Technology' },
      suggestions: [],
    });
    mockResolve.mockResolvedValueOnce({
      input: 'tech-2',
      match: { id: 'tech-2', name: 'Oracle DB', type: 'Technology' },
      suggestions: [],
    });
    mockExplain.mockResolvedValueOnce({ connected: false, explanation: 'nope' });

    const r = await executeFindGraphPath({ fromId: 'tech-1', toId: 'tech-2', maxDepth: 4 });

    expect(r.status).toBe('no_path');
    expect(r.connected).toBe(false);
    expect(r.paths).toEqual([]);
    expect(r.resolved?.from.name).toBe('LangChain');
    expect(r.resolved?.to.name).toBe('Oracle DB');
    expect(r.explanation).toMatch(/No path between "LangChain" and "Oracle DB" within 4 hops/);
  });

  it('returns status=path_found with the resolved ids when a path exists', async () => {
    mockResolve.mockResolvedValueOnce({
      input: 'LangChain',
      match: { id: 'tech-1', name: 'LangChain', type: 'Technology' },
      suggestions: [],
    });
    mockResolve.mockResolvedValueOnce({
      input: 'Anthropic',
      match: { id: 'co-1', name: 'Anthropic', type: 'Company' },
      suggestions: [],
    });
    mockExplain.mockResolvedValueOnce({
      connected: true,
      explanation: 'LangChain uses Claude API which is made by Anthropic.',
    });
    mockFindPath.mockResolvedValueOnce({ nodes: [{}, {}], relations: [{}] });

    const r = await executeFindGraphPath({ fromId: 'LangChain', toId: 'Anthropic' });

    expect(r.status).toBe('path_found');
    expect(r.connected).toBe(true);
    expect(r.paths).toHaveLength(1);
    expect(r.resolved?.from.id).toBe('tech-1');
    expect(r.resolved?.to.id).toBe('co-1');
  });

  it('honours findAll=true by invoking findAllPaths with pathLimit', async () => {
    mockResolve.mockResolvedValue({
      input: 'x',
      match: { id: 'x', name: 'X', type: 'Technology' },
      suggestions: [],
    });
    mockExplain.mockResolvedValueOnce({ connected: true, explanation: 'ok' });
    mockFindAll.mockResolvedValueOnce([
      { nodes: [{}, {}], relations: [{}] },
      { nodes: [{}, {}], relations: [{}] },
    ]);

    const r = await executeFindGraphPath({ fromId: 'x', toId: 'x', findAll: true, pathLimit: 3 });

    expect(mockFindAll).toHaveBeenCalledWith('x', 'x', { maxDepth: 6, pathLimit: 3 });
    expect(r.paths).toHaveLength(2);
  });

  it('returns status=error for missing input', async () => {
    const r = await executeFindGraphPath({ fromId: '', toId: 'x' });
    expect(r.status).toBe('error');
    expect(r.success).toBe(false);
  });
});
