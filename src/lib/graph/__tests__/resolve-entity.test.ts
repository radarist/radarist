/**
 * @file resolve-entity.test.ts
 * @description Unit tests for the graph entity resolver used by chat tools.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
}));

import * as neo4j from '../neo4j-client';
import { resolveEntityByIdOrName } from '../resolve-entity';

const mockedRead = neo4j.runReadTransaction as jest.Mock;

const readResult = (records: Record<string, unknown>[]) => ({
  records,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

describe('resolveEntityByIdOrName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty outcome for blank input', async () => {
    const r = await resolveEntityByIdOrName('');
    expect(r.match).toBeNull();
    expect(r.suggestions).toEqual([]);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('matches by exact id first and skips the name branch', async () => {
    mockedRead.mockResolvedValueOnce(readResult([{ id: 'tech-1', name: 'LangChain', type: 'Technology' }]));

    const r = await resolveEntityByIdOrName('tech-1');

    expect(r.match).toEqual({ id: 'tech-1', name: 'LangChain', type: 'Technology' });
    expect(mockedRead).toHaveBeenCalledTimes(1);
  });

  it('falls back to name search when id lookup misses', async () => {
    mockedRead.mockResolvedValueOnce(readResult([])); // id miss
    mockedRead.mockResolvedValueOnce(
      readResult([
        { id: 'tech-a', name: 'LangChain Framework', type: 'Technology', score: 9 },
        { id: 'tech-b', name: 'LangChain SDK', type: 'Technology', score: 12 },
      ])
    );

    const r = await resolveEntityByIdOrName('langchain');

    expect(r.match).toEqual({ id: 'tech-a', name: 'LangChain Framework', type: 'Technology' });
    expect(r.suggestions).toEqual([{ id: 'tech-b', name: 'LangChain SDK', type: 'Technology' }]);
    expect(mockedRead).toHaveBeenCalledTimes(2);
  });

  it('returns match=null with empty suggestions when nothing matches', async () => {
    mockedRead.mockResolvedValueOnce(readResult([]));
    mockedRead.mockResolvedValueOnce(readResult([]));

    const r = await resolveEntityByIdOrName('neverland');

    expect(r.match).toBeNull();
    expect(r.suggestions).toEqual([]);
  });

  it('suggestionLimit caps the alt list size', async () => {
    mockedRead.mockResolvedValueOnce(readResult([]));
    mockedRead.mockResolvedValueOnce(
      readResult([
        { id: '1', name: 'A', type: 'Technology', score: 0 },
        { id: '2', name: 'B', type: 'Technology', score: 1 },
        { id: '3', name: 'C', type: 'Technology', score: 2 },
        { id: '4', name: 'D', type: 'Technology', score: 3 },
      ])
    );

    const r = await resolveEntityByIdOrName('x', 2);

    expect(r.match?.id).toBe('1');
    expect(r.suggestions.map((s) => s.id)).toEqual(['2', '3']);
  });
});
