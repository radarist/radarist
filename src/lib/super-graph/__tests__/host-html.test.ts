import { buildHostHtml } from '../host-html';
import { brandDark } from '../design-tokens';

describe('buildHostHtml (echarts branch)', () => {
  const tokens = brandDark();

  it('throws with the option path when the option contains a function', () => {
    expect(() =>
      buildHostHtml({
        branch: 'echarts',
        kind: 'bubble',
        data: { option: { series: [{ symbolSize: () => 10 }] } },
        tokens,
      })
    ).toThrow(/option\.series\[0\]\.symbolSize/);
  });

  it('forces animation off for static snapshot capture', () => {
    const html = buildHostHtml({
      branch: 'echarts',
      kind: 'bubble',
      data: { option: { series: [{ type: 'scatter', data: [] }] } },
      tokens,
    });
    expect(html).toContain('{ animation: false }');
  });

  it('renders a JSON-pure option without throwing', () => {
    const html = buildHostHtml({
      branch: 'echarts',
      kind: 'treemap',
      data: { option: { series: [{ type: 'treemap', label: { formatter: '{b}\n{c}' } }] } },
      tokens,
    });
    expect(html).toContain('registerTheme');
  });
});
