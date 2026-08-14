/**
 * Unit Tests for URL Normalization Utility
 *
 * Tests URL normalization functions for document deduplication:
 * - normalizeUrl: Main normalization function
 * - extractDomain: Domain extraction
 * - areUrlsDuplicates: Duplicate detection
 * - isValidUrl: URL validation
 * - ensureProtocol: Protocol handling
 *
 * @jest-environment node
 * @phase Knowledge Tab Sprint
 */

import { describe, it, expect } from '@jest/globals';
import {
  normalizeUrl,
  extractDomain,
  areUrlsDuplicates,
  getSafeExternalUrl,
  isValidUrl,
  ensureProtocol,
} from '../utils/url-normalize';

describe('normalizeUrl', () => {
  describe('protocol normalization', () => {
    it('should lowercase protocol', () => {
      expect(normalizeUrl('HTTPS://example.com')).toBe('https://example.com/');
      expect(normalizeUrl('HTTP://example.com')).toBe('http://example.com/');
    });
  });

  describe('hostname normalization', () => {
    it('should lowercase hostname', () => {
      expect(normalizeUrl('https://EXAMPLE.COM')).toBe('https://example.com/');
      expect(normalizeUrl('https://Example.Com/Path')).toBe('https://example.com/path');
    });

    it('should remove www. prefix by default', () => {
      expect(normalizeUrl('https://www.example.com')).toBe('https://example.com/');
      expect(normalizeUrl('https://WWW.Example.COM')).toBe('https://example.com/');
    });

    it('should keep www. when removeWww is false', () => {
      expect(normalizeUrl('https://www.example.com', { removeWww: false })).toBe(
        'https://www.example.com/'
      );
    });
  });

  describe('pathname normalization', () => {
    it('should remove trailing slash from paths', () => {
      expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
      expect(normalizeUrl('https://example.com/path/to/page/')).toBe(
        'https://example.com/path/to/page'
      );
    });

    it('should keep trailing slash for root path', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
      expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
    });

    it('should lowercase pathname', () => {
      expect(normalizeUrl('https://example.com/Path/To/Page')).toBe(
        'https://example.com/path/to/page'
      );
    });
  });

  describe('tracking parameter removal', () => {
    it('should remove UTM parameters', () => {
      expect(
        normalizeUrl('https://example.com/page?utm_source=google&utm_medium=cpc&foo=bar')
      ).toBe('https://example.com/page?foo=bar');
    });

    it('should remove Facebook tracking parameters', () => {
      expect(normalizeUrl('https://example.com/page?fbclid=abc123&foo=bar')).toBe(
        'https://example.com/page?foo=bar'
      );
    });

    it('should remove Google click ID', () => {
      expect(normalizeUrl('https://example.com/page?gclid=xyz&foo=bar')).toBe(
        'https://example.com/page?foo=bar'
      );
    });

    it('should remove all common tracking parameters', () => {
      const trackingUrl =
        'https://example.com/page?utm_source=a&utm_medium=b&utm_campaign=c&fbclid=d&gclid=e&msclkid=f&keep=this';
      expect(normalizeUrl(trackingUrl)).toBe('https://example.com/page?keep=this');
    });

    it('should keep tracking params when removeTrackingParams is false', () => {
      expect(
        normalizeUrl('https://example.com?utm_source=google', { removeTrackingParams: false })
      ).toBe('https://example.com/?utm_source=google');
    });
  });

  describe('query parameter sorting', () => {
    it('should sort query parameters alphabetically', () => {
      expect(normalizeUrl('https://example.com?z=1&a=2&m=3')).toBe(
        'https://example.com/?a=2&m=3&z=1'
      );
    });

    it('should not sort when sortQueryParams is false', () => {
      const result = normalizeUrl('https://example.com?z=1&a=2', { sortQueryParams: false });
      // When not sorting, order is preserved
      expect(result).toBe('https://example.com/?z=1&a=2');
    });
  });

  describe('hash/fragment handling', () => {
    it('should remove hash by default', () => {
      expect(normalizeUrl('https://example.com/page#section')).toBe(
        'https://example.com/page'
      );
    });

    it('should keep hash when removeHash is false', () => {
      expect(normalizeUrl('https://example.com/page#section', { removeHash: false })).toBe(
        'https://example.com/page#section'
      );
    });
  });

  describe('additional params to remove', () => {
    it('should remove custom parameters', () => {
      expect(
        normalizeUrl('https://example.com?custom=value&keep=this', {
          additionalParamsToRemove: ['custom'],
        })
      ).toBe('https://example.com/?keep=this');
    });
  });

  describe('error handling', () => {
    it('should throw on invalid URL', () => {
      expect(() => normalizeUrl('not-a-url')).toThrow();
      expect(() => normalizeUrl('')).toThrow();
    });
  });

  describe('complex URLs', () => {
    it('should handle URLs with all variations', () => {
      const messy =
        'HTTPS://WWW.Example.Com/Path/To/Page/?utm_source=google&b=2&a=1&fbclid=xyz#section';
      expect(normalizeUrl(messy)).toBe('https://example.com/path/to/page?a=1&b=2');
    });

    it('should handle URLs with port numbers', () => {
      expect(normalizeUrl('https://example.com:8080/path')).toBe(
        'https://example.com:8080/path'
      );
    });

    it('should handle URLs with authentication', () => {
      expect(normalizeUrl('https://user:pass@example.com/path')).toBe(
        'https://user:pass@example.com/path'
      );
    });
  });
});

describe('extractDomain', () => {
  it('should extract root domain', () => {
    expect(extractDomain('https://blog.example.com/post')).toBe('example.com');
    expect(extractDomain('https://sub.blog.example.com/post')).toBe('example.com');
  });

  it('should include subdomain when requested', () => {
    expect(extractDomain('https://blog.example.com/post', true)).toBe('blog.example.com');
  });

  it('should remove www. prefix', () => {
    expect(extractDomain('https://www.example.com')).toBe('example.com');
  });

  it('should handle special TLDs', () => {
    expect(extractDomain('https://blog.example.co.uk')).toBe('example.co.uk');
    expect(extractDomain('https://blog.example.com.au')).toBe('example.com.au');
  });

  it('should throw on invalid URL', () => {
    expect(() => extractDomain('not-a-url')).toThrow();
  });
});

describe('areUrlsDuplicates', () => {
  it('should detect duplicate URLs', () => {
    expect(
      areUrlsDuplicates('https://example.com/path?utm_source=a', 'https://example.com/path')
    ).toBe(true);
  });

  it('should detect www vs non-www as duplicates', () => {
    expect(areUrlsDuplicates('https://www.example.com', 'https://example.com')).toBe(true);
  });

  it('should detect trailing slash variations as duplicates', () => {
    expect(areUrlsDuplicates('https://example.com/path/', 'https://example.com/path')).toBe(
      true
    );
  });

  it('should return false for different URLs', () => {
    expect(
      areUrlsDuplicates('https://example.com/page1', 'https://example.com/page2')
    ).toBe(false);
  });

  it('should return false for invalid URLs', () => {
    expect(areUrlsDuplicates('not-a-url', 'https://example.com')).toBe(false);
    expect(areUrlsDuplicates('https://example.com', 'not-a-url')).toBe(false);
  });
});

describe('isValidUrl', () => {
  it('should return true for valid URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('http://example.com/path?query=1')).toBe(true);
    expect(isValidUrl('ftp://files.example.com')).toBe(true);
  });

  it('should return false for invalid URLs', () => {
    expect(isValidUrl('not-a-url')).toBe(false);
    expect(isValidUrl('')).toBe(false);
    expect(isValidUrl('example.com')).toBe(false); // Missing protocol
  });
});

describe('getSafeExternalUrl', () => {
  it('keeps exact HTTP(S) source paths and normalizes surrounding whitespace', () => {
    expect(getSafeExternalUrl('  https://example.com/research?id=42#results  ')).toBe(
      'https://example.com/research?id=42#results'
    );
    expect(getSafeExternalUrl('http://example.com/source')).toBe('http://example.com/source');
  });

  it.each([
    undefined,
    '',
    'example.com/source',
    'javascript:alert(1)',
    'file:///tmp/private',
    'https://user:secret@example.com/private',
  ])('rejects missing, malformed, credentialed, or non-web values: %s', (value) => {
    expect(getSafeExternalUrl(value)).toBeNull();
  });
});

describe('ensureProtocol', () => {
  it('should add https:// to URLs without protocol', () => {
    expect(ensureProtocol('example.com/path')).toBe('https://example.com/path');
    expect(ensureProtocol('www.example.com')).toBe('https://www.example.com');
  });

  it('should preserve existing protocol', () => {
    expect(ensureProtocol('http://example.com')).toBe('http://example.com');
    expect(ensureProtocol('https://example.com')).toBe('https://example.com');
    expect(ensureProtocol('ftp://files.example.com')).toBe('ftp://files.example.com');
  });

  it('should handle protocol-relative URLs', () => {
    expect(ensureProtocol('//example.com/path')).toBe('https://example.com/path');
  });

  it('should trim whitespace', () => {
    expect(ensureProtocol('  example.com  ')).toBe('https://example.com');
  });
});
