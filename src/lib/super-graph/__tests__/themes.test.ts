import { lightEditorial, brandDark } from '../design-tokens';
import { mermaidTheme } from '../themes/mermaid';
import { echartsTheme } from '../themes/echarts';

describe('mermaidTheme', () => {
  it('translates DesignTokens to mermaid themeVariables', () => {
    const t = lightEditorial();
    const vars = mermaidTheme(t);
    expect(vars.fontFamily).toBe(t.type.family);
    expect(vars.primaryColor).toBe(t.color.sequence[0]);
    expect(vars.background).toBe(t.color.canvas);
    expect(vars.primaryTextColor).toBe(t.color.ink);
  });
});

describe('echartsTheme', () => {
  it('translates DesignTokens to ECharts theme config', () => {
    const t = lightEditorial();
    const cfg = echartsTheme(t);
    expect(cfg.color).toEqual(t.color.sequence);
    expect(cfg.backgroundColor).toBe(t.color.canvas);
    expect(cfg.textStyle.fontFamily).toBe(t.type.family);
    expect(cfg.textStyle.color).toBe(t.color.ink);
  });

  it('switches sensible defaults for dark mode', () => {
    const cfg = echartsTheme(brandDark());
    expect(cfg.backgroundColor).toMatch(/^#0[0-9a-f]/i);
    expect(cfg.textStyle.color).not.toBe('#0f172a');
  });
});
