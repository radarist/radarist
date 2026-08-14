/**
 * @jest-environment node
 */
import { applyQuotasAndMMR } from '../diversity-quotas';

type C = { entityId: string; entityType: string; score: number };
const mk = (entityId: string, entityType: string, score: number): C => ({ entityId, entityType, score });

describe('applyQuotasAndMMR', () => {
  it('reserves a per-dimension quota even when one type dominates by score', () => {
    const pool: C[] = [
      mk('a1', 'technology', 0.9),
      mk('a2', 'technology', 0.85),
      mk('a3', 'technology', 0.8),
      mk('b1', 'company', 0.5),
    ];
    const out = applyQuotasAndMMR(pool, { perDimensionQuota: 1, maxEntityTypeShare: 1, mmrLambda: 1, limit: 3 });
    expect(out.some((c) => c.entityType === 'company')).toBe(true); // company's quota is honored
    expect(out).toHaveLength(3);
  });

  it('never invents candidates beyond the supply', () => {
    const pool: C[] = [mk('a1', 'technology', 0.9)];
    const out = applyQuotasAndMMR(pool, { perDimensionQuota: 5, maxEntityTypeShare: 1, mmrLambda: 1, limit: 10 });
    expect(out).toHaveLength(1);
  });

  it('caps any one type at floor(limit*maxEntityTypeShare) when supply allows', () => {
    const pool: C[] = [
      mk('a1', 'technology', 0.9),
      mk('a2', 'technology', 0.8),
      mk('a3', 'technology', 0.7),
      mk('b1', 'company', 0.6),
      mk('b2', 'company', 0.5),
    ];
    const out = applyQuotasAndMMR(pool, { perDimensionQuota: 0, maxEntityTypeShare: 0.5, mmrLambda: 1, limit: 4 });
    const techCount = out.filter((c) => c.entityType === 'technology').length;
    expect(techCount).toBeLessThanOrEqual(2); // floor(4*0.5)=2
  });

  it('λ=1 recovers pure relevance order; λ=0 maximizes type diversity', () => {
    const pool: C[] = [mk('a1', 'technology', 0.9), mk('a2', 'technology', 0.85), mk('b1', 'company', 0.4)];
    const relevance = applyQuotasAndMMR(pool, { perDimensionQuota: 0, maxEntityTypeShare: 1, mmrLambda: 1, limit: 2 });
    expect(relevance.map((c) => c.entityId)).toEqual(['a1', 'a2']); // pure score

    const diversity = applyQuotasAndMMR(pool, { perDimensionQuota: 0, maxEntityTypeShare: 1, mmrLambda: 0, limit: 2 });
    expect(diversity.map((c) => c.entityType).sort()).toEqual(['company', 'technology']); // one of each
  });

  it('respects the limit', () => {
    const pool: C[] = Array.from({ length: 10 }, (_, i) => mk(`t${i}`, 'technology', 1 - i * 0.05));
    expect(
      applyQuotasAndMMR(pool, { perDimensionQuota: 0, maxEntityTypeShare: 1, mmrLambda: 1, limit: 3 })
    ).toHaveLength(3);
  });
});
