import {
  buildInitiativeLinkProjection,
  INITIATIVE_LINK_PROJECTION_OWNER,
} from '../initiative-link-projection';

describe('Initiative link projection contract', () => {
  it('normalizes authoritative references without inventing targets', () => {
    expect(
      buildInitiativeLinkProjection('initiative-1', {
        linkedStrategyIds: [' strategy-1 ', 'strategy-1', '', 42, null],
        linkedPainPointIds: ['pain-1', 'pain-2', 'pain-1', undefined],
      })
    ).toEqual({
      query: expect.stringContaining('projectionOwner: $projectionOwner'),
      params: {
        initiativeId: 'initiative-1',
        strategyIds: ['strategy-1'],
        painPointIds: ['pain-1', 'pain-2'],
        projectionOwner: INITIATIVE_LINK_PROJECTION_OWNER,
      },
    });
  });

  it('treats absent and malformed arrays as no authoritative links', () => {
    expect(
      buildInitiativeLinkProjection('initiative-1', {
        linkedStrategyIds: 'strategy-1',
        linkedPainPointIds: { id: 'pain-1' },
      }).params
    ).toMatchObject({ strategyIds: [], painPointIds: [] });
  });

  it('reconciles only explicitly owned IMPLEMENTS and DRIVES projections', () => {
    const { query } = buildInitiativeLinkProjection('initiative-1', {});

    expect(query).toContain('(initiative)-[edge:IMPLEMENTS {projectionOwner: $projectionOwner}]->(strategy)');
    expect(query).toContain('(painPoint)-[edge:DRIVES {projectionOwner: $projectionOwner}]->(initiative)');
    expect(query).toContain('staleStrategyEdge.projectionOwner = $projectionOwner');
    expect(query).toContain('stalePainPointEdge.projectionOwner = $projectionOwner');
    expect(query).not.toContain('relationId IS NULL');
    expect(query).not.toContain('claimId IS NULL');
  });
});
