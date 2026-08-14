/**
 * Tests for lib/branding.ts
 *
 * The OSS distribution exposes a single neutral brand. The historical
 * `NEXT_PUBLIC_BRANDING` env-var-driven multi-variant system has been removed,
 * so these tests pin the surviving surface area.
 */

describe('branding', () => {
  it('getBrandingType returns the single neutral brand', () => {
    const { getBrandingType } = require('../branding');
    expect(getBrandingType()).toBe('radarist');
  });

  it('getBrandingConfig exposes the Radarist defaults', () => {
    const { getBrandingConfig } = require('../branding');
    const config = getBrandingConfig();
    expect(config.name).toBe('Radarist');
    expect(config.fullName).toBe('Radarist');
    expect(config.logoAlt).toBe('Radarist');
  });

  it('user defaults are neutral (no personal identity)', () => {
    const { getBrandingConfig } = require('../branding');
    const config = getBrandingConfig();
    expect(config.user.name).toBe('User');
    expect(config.user.email).toBe('');
    expect(config.user.avatar).toBe('');
  });

  it('color palette uses brand primary/secondary hex strings', () => {
    const { getBrandingConfig } = require('../branding');
    const config = getBrandingConfig();
    expect(config.colors.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(config.colors.secondary).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
