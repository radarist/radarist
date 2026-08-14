/**
 * @jest-environment node
 */
import { getTwoHopJoin } from '../two-hop-whitelist';

describe('two-hop-whitelist', () => {
  it('painPoint join: hop1 SOLVES/incoming->technology, hop2 ADDRESSES/outgoing->useCase, addresses', () => {
    const j = getTwoHopJoin('painPoint');
    expect(j).toBeDefined();
    expect(j!.hop1).toEqual({ relationTypes: ['SOLVES'], direction: 'incoming', targetLabel: 'technology' });
    expect(j!.hop2).toEqual({ relationTypes: ['ADDRESSES'], direction: 'outgoing', targetLabel: 'useCase' });
    expect(j!.proposedRelationType).toBe('addresses');
    // ADDRESSES does not touch painPoint — it must NOT be the painPoint hop1.
    expect(j!.hop1.relationTypes).not.toContain('ADDRESSES');
  });

  it('has NO join for excluded source types', () => {
    for (const t of ['orgUnit', 'report', 'concept', 'document', 'signal']) {
      expect(getTwoHopJoin(t)).toBeUndefined();
    }
  });
});
