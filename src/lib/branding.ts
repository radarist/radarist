/**
 * Branding Configuration
 *
 * Single neutral brand for the open-source distribution.
 * The historical multi-variant `NEXT_PUBLIC_BRANDING` env var has been removed —
 * downstream forks should edit this module directly.
 */

export type BrandingType = 'radarist';

export interface BrandingConfig {
  name: string;
  fullName: string;
  logoAlt: string;
  user: {
    name: string;
    email: string;
    avatar: string;
  };
  colors: {
    primary: string;
    secondary: string;
  };
}

const radaristBranding: BrandingConfig = {
  name: 'Radarist',
  fullName: 'Radarist',
  logoAlt: 'Radarist',
  user: {
    name: 'User',
    email: '',
    avatar: '',
  },
  colors: {
    primary: '#39A9DB',
    secondary: '#d63230',
  },
};

/**
 * Get the active branding type. Always returns the single neutral brand —
 * kept as a function for API compatibility with prior multi-variant builds.
 */
export function getBrandingType(): BrandingType {
  return 'radarist';
}

/**
 * Get the branding configuration for the current environment.
 */
export function getBrandingConfig(): BrandingConfig {
  return radaristBranding;
}
