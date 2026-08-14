/**
 * Tests for lib/company-utils.ts
 *
 * Utility functions for company operations:
 * - fetchCompanyLogo: Clearbit logo URL construction
 * - extractDomain: URL → domain extraction
 * - validateWebsite: URL validation
 * - normalizeWebsite: URL normalization
 * - formatCompanySize: Size enum → human-readable string
 * - getStatusColor: Status → Tailwind CSS class
 * - getRelationshipTypeColor: Relationship type → Tailwind CSS class
 * - getCompanyInitials: Company name → initials
 */

import {
  fetchCompanyLogo,
  extractDomain,
  validateWebsite,
  normalizeWebsite,
  formatCompanySize,
  getStatusColor,
  getRelationshipTypeColor,
  getCompanyInitials,
} from '../company-utils';
import type { Company } from '../types';

// ============================================================================
// TEST HELPERS
// ============================================================================

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'company-1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    description: 'A test company',
    website: 'https://acme.example.com',
    type: ['startup'],
    industry: ['technology'],
    size: 'small',
    stage: 'seed',
    location: { city: 'Paris', country: 'France' },
    status: 'Watching',
    tags: ['cloud', 'saas'],
    socialLinks: {},
    technologyStack: ['React', 'Node.js'],
    documents: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as Company;
}

// ============================================================================
// fetchCompanyLogo
// ============================================================================

describe('fetchCompanyLogo', () => {
  it('should return Clearbit URL for a valid domain', async () => {
    const result = await fetchCompanyLogo('https://www.datadog.com');
    expect(result).toBe('https://logo.clearbit.com/datadog.com');
  });

  it('should return Clearbit URL for a URL without www', async () => {
    const result = await fetchCompanyLogo('https://github.com');
    expect(result).toBe('https://logo.clearbit.com/github.com');
  });

  it('should return null when the URL has no parseable hostname', async () => {
    // "https://" alone has no hostname, so extractDomain returns null
    const result = await fetchCompanyLogo('https://');
    expect(result).toBeNull();
  });

  it('should handle URLs without protocol', async () => {
    const result = await fetchCompanyLogo('stripe.com');
    expect(result).toBe('https://logo.clearbit.com/stripe.com');
  });
});

// ============================================================================
// extractDomain
// ============================================================================

describe('extractDomain', () => {
  it('should extract domain from full URL', () => {
    expect(extractDomain('https://www.datadog.com/products/apm')).toBe('datadog.com');
  });

  it('should remove www. prefix', () => {
    expect(extractDomain('http://www.github.com')).toBe('github.com');
  });

  it('should handle URL without www', () => {
    expect(extractDomain('https://stripe.com')).toBe('stripe.com');
  });

  it('should handle URL without protocol', () => {
    expect(extractDomain('acme.example.com')).toBe('acme.example.com');
  });

  it('should return null for an invalid URL', () => {
    expect(extractDomain('not a url')).toBeNull();
  });

  it('should handle empty string gracefully', () => {
    // Empty string causes URL parsing to fail
    expect(extractDomain('')).toBeNull();
  });
});

// ============================================================================
// validateWebsite
// ============================================================================

describe('validateWebsite', () => {
  it('should return true for a valid https URL', () => {
    expect(validateWebsite('https://www.datadog.com')).toBe(true);
  });

  it('should return true for a valid http URL', () => {
    expect(validateWebsite('http://example.com')).toBe(true);
  });

  it('should return true for a domain without protocol (adds https)', () => {
    expect(validateWebsite('datadog.com')).toBe(true);
  });

  it('should return false for a completely invalid URL', () => {
    expect(validateWebsite('not a url at all')).toBe(false);
  });

  it('should return false for an empty string', () => {
    expect(validateWebsite('')).toBe(false);
  });
});

// ============================================================================
// normalizeWebsite
// ============================================================================

describe('normalizeWebsite', () => {
  it('should add https:// when no protocol is present', () => {
    expect(normalizeWebsite('datadog.com')).toBe('https://datadog.com');
  });

  it('should preserve existing https:// protocol', () => {
    expect(normalizeWebsite('https://www.datadog.com')).toBe('https://www.datadog.com');
  });

  it('should preserve existing http:// protocol', () => {
    expect(normalizeWebsite('http://datadog.com')).toBe('http://datadog.com');
  });

  it('should not double-add the protocol', () => {
    const result = normalizeWebsite('https://example.com');
    expect(result.startsWith('https://')).toBe(true);
    expect(result).not.toContain('https://https://');
  });
});

// ============================================================================
// formatCompanySize
// ============================================================================

describe('formatCompanySize', () => {
  it('should format "micro"', () => {
    expect(formatCompanySize('micro')).toBe('Micro (1-9 employees)');
  });

  it('should format "small"', () => {
    expect(formatCompanySize('small')).toBe('Small (10-49 employees)');
  });

  it('should format "medium"', () => {
    expect(formatCompanySize('medium')).toBe('Medium (50-249 employees)');
  });

  it('should format "large"', () => {
    expect(formatCompanySize('large')).toBe('Large (250-999 employees)');
  });

  it('should format "enterprise"', () => {
    expect(formatCompanySize('enterprise')).toBe('Enterprise (>1000 employees)');
  });
});

// ============================================================================
// getStatusColor
// ============================================================================

describe('getStatusColor', () => {
  it('should return blue classes for "Watching"', () => {
    const result = getStatusColor('Watching');
    expect(result).toContain('blue');
  });

  it('should return yellow classes for "Contacted"', () => {
    const result = getStatusColor('Contacted');
    expect(result).toContain('yellow');
  });

  it('should return green classes for "Partner"', () => {
    const result = getStatusColor('Partner');
    expect(result).toContain('green');
  });

  it('should return red classes for "Rejected"', () => {
    const result = getStatusColor('Rejected');
    expect(result).toContain('red');
  });

  it('should return gray classes for unknown status', () => {
    const result = getStatusColor('Unknown');
    expect(result).toContain('gray');
  });

  it('should return a non-empty string for any input', () => {
    expect(getStatusColor('').length).toBeGreaterThan(0);
  });
});

// ============================================================================
// getRelationshipTypeColor
// ============================================================================

describe('getRelationshipTypeColor', () => {
  it('should return purple classes for "Vendor"', () => {
    const result = getRelationshipTypeColor('Vendor');
    expect(result).toContain('purple');
  });

  it('should return blue classes for "User"', () => {
    const result = getRelationshipTypeColor('User');
    expect(result).toContain('blue');
  });

  it('should return green classes for "Partner"', () => {
    const result = getRelationshipTypeColor('Partner');
    expect(result).toContain('green');
  });

  it('should return orange classes for "Competitor"', () => {
    const result = getRelationshipTypeColor('Competitor');
    expect(result).toContain('orange');
  });

  it('should return gray classes for unknown relationship type', () => {
    const result = getRelationshipTypeColor('Unknown');
    expect(result).toContain('gray');
  });
});

// ============================================================================
//// ============================================================================



// ============================================================================
//// ============================================================================



// ============================================================================
// getCompanyInitials
// ============================================================================

describe('getCompanyInitials', () => {
  it('should return first 2 chars uppercase for single-word name', () => {
    expect(getCompanyInitials('Datadog')).toBe('DA');
  });

  it('should return first 2 chars for short single-word name', () => {
    expect(getCompanyInitials('IBM')).toBe('IB');
  });

  it('should return initials of first two words', () => {
    expect(getCompanyInitials('Amazon Web Services')).toBe('AW');
  });

  it('should be uppercase', () => {
    expect(getCompanyInitials('lowercase name')).toBe('LN');
  });

  it('should handle leading/trailing whitespace', () => {
    const result = getCompanyInitials('  Acme Corp  ');
    expect(result).toBe('AC');
  });

  it('should return initials for exactly two words', () => {
    expect(getCompanyInitials('Tech Corp')).toBe('TC');
  });
});

export {};
