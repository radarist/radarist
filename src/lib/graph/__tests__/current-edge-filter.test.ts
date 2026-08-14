import { currentEdgePredicate, currentPathPredicate } from '../current-edge-filter';

describe('current edge Cypher filters', () => {
  it('treats legacy edges as live but excludes invalidated and rejected facts', () => {
    expect(currentEdgePredicate('r')).toBe(
      "r.t_invalidated IS NULL AND coalesce(r.claimStatus, 'curated') <> 'rejected'"
    );
  });

  it('applies the same rule to every relationship in a path', () => {
    expect(currentPathPredicate('path')).toContain('ALL(currentRel IN relationships(path)');
    expect(currentPathPredicate('path')).toContain('currentRel.t_invalidated IS NULL');
    expect(currentPathPredicate('path')).toContain("currentRel.claimStatus, 'curated'");
  });

  it('rejects invalid aliases before they reach a query string', () => {
    expect(() => currentEdgePredicate('r) DELETE r')).toThrow('Invalid internal Cypher alias');
  });
});
