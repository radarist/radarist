import { isTokenBlend, parseHexColor } from '../color-blend';

describe('parseHexColor', () => {
  it('parses 6-digit and 3-digit hex', () => {
    expect(parseHexColor('#3fb68b')).toEqual([63, 182, 139]);
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
    expect(parseHexColor('#FFAA00')).toEqual([255, 170, 0]);
  });

  it('parses 8-digit hex by ignoring alpha', () => {
    expect(parseHexColor('#3fb68b80')).toEqual([63, 182, 139]);
  });

  it('rejects non-hex input', () => {
    expect(parseHexColor('rgb(1,2,3)')).toBeNull();
    expect(parseHexColor('#12')).toBeNull();
    expect(parseHexColor('tomato')).toBeNull();
  });
});

describe('isTokenBlend', () => {
  const allow: Array<[number, number, number]> = [
    [63, 182, 139], // positive #3fb68b
    [224, 92, 92], // negative #e05c5c
    [160, 122, 58], // warning #a07a3a
    [15, 23, 42], // ink #0f172a
    [250, 250, 247], // canvas #fafaf7
  ];

  it('accepts exact allow-set members', () => {
    expect(isTokenBlend('#3fb68b', allow)).toBe(true);
    expect(isTokenBlend('#e05c5c', allow)).toBe(true);
  });

  it('accepts a midpoint blend of two members (visualMap interpolant)', () => {
    // midpoint of positive and negative: (143.5, 137, 115.5)
    expect(isTokenBlend('#908974', allow)).toBe(true);
    // 25% along warning → negative: (176, 114.5, 66.5)
    expect(isTokenBlend('#b07343', allow)).toBe(true);
  });

  it('rejects foreign saturated colors', () => {
    expect(isTokenBlend('#ff00ff', allow)).toBe(false);
    expect(isTokenBlend('#00e5ff', allow)).toBe(false);
  });

  it('rejects colors beyond the segment (extrapolation is not a blend)', () => {
    // Past negative on the positive→negative line: t would exceed 1.
    expect(isTokenBlend('#ff2a2a', allow)).toBe(false);
  });

  it('rejects unparseable input', () => {
    expect(isTokenBlend('hsl(10, 50%, 50%)', allow)).toBe(false);
  });
});
