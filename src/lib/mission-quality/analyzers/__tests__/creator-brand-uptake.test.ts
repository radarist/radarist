import {
  analyzeCreatorBrand,
  measureBrandUptake,
} from '@/lib/mission-quality/analyzers/creator-brand-analyzer';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';

describe('creator brand uptake telemetry', () => {
  it('counts applied shared and private classes without treating private vocabulary as a defect', () => {
    const html =
      '<link rel="stylesheet" href="/css/report-brand.css"><style>' +
      Array.from({ length: 20 }, (_, index) => `.private-${index}{color:red}`).join('') +
      '</style><div class="stat-card private-0"><span class="private-1">x</span></div>';
    expect(measureBrandUptake(html)).toEqual({
      brandClassesUsed: 1,
      inventedClassesUsed: 2,
      share: 1 / 3,
    });
    const verdict = analyzeCreatorBrand(html, resolveDesignBrief('owner'));
    expect(verdict.ok ? [] : verdict.violations.map((violation) => violation.check)).not.toContain(
      'excessive-custom-classes'
    );
  });

  it('reports zero when no classes are applied', () => {
    expect(measureBrandUptake('<p>plain</p>')).toEqual({
      brandClassesUsed: 0,
      inventedClassesUsed: 0,
      share: 0,
    });
  });
});
