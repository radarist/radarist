/**
 * URL Normalization Utility
 *
 * Normalizes URLs to prevent duplicates in the document library.
 * Handles common URL variations that should be treated as the same document.
 *
 * @phase Knowledge Tab Sprint
 */

/**
 * Common tracking parameters to remove from URLs.
 * These are typically added by marketing/analytics tools and don't affect content.
 */
const TRACKING_PARAMS = [
  // UTM parameters (Google Analytics)
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  // Facebook
  'fbclid',
  'fb_action_ids',
  'fb_action_types',
  'fb_source',
  // Google
  'gclid',
  'gclsrc',
  'dclid',
  // Microsoft
  'msclkid',
  // Twitter
  'twclid',
  // LinkedIn
  'li_fat_id',
  // Mailchimp
  'mc_eid',
  'mc_cid',
  // HubSpot
  '_hsenc',
  '_hsmi',
  '__hstc',
  '__hsfp',
  'hsCtaTracking',
  // Generic
  'ref',
  'source',
  'campaign',
];

/**
 * Options for URL normalization.
 */
export interface NormalizeUrlOptions {
  /**
   * Whether to remove www. prefix from hostname.
   * @default true
   */
  removeWww?: boolean;

  /**
   * Whether to remove tracking parameters.
   * @default true
   */
  removeTrackingParams?: boolean;

  /**
   * Whether to remove hash/fragment.
   * @default true
   */
  removeHash?: boolean;

  /**
   * Whether to sort query parameters for consistency.
   * @default true
   */
  sortQueryParams?: boolean;

  /**
   * Additional parameters to remove (beyond tracking params).
   */
  additionalParamsToRemove?: string[];
}

const DEFAULT_OPTIONS: Required<NormalizeUrlOptions> = {
  removeWww: true,
  removeTrackingParams: true,
  removeHash: true,
  sortQueryParams: true,
  additionalParamsToRemove: [],
};

/**
 * Normalizes a URL for deduplication purposes.
 *
 * Normalization includes:
 * - Lowercase protocol and hostname
 * - Remove trailing slash (except for root path)
 * - Remove common tracking parameters (utm_*, fbclid, gclid, etc.)
 * - Sort remaining query parameters
 * - Optionally remove www. prefix
 * - Optionally remove hash/fragment
 *
 * @param url - The URL to normalize
 * @param options - Normalization options
 * @returns Normalized URL string
 * @throws Error if URL is invalid
 *
 * @example
 * ```typescript
 * normalizeUrl('HTTPS://WWW.Example.Com/Path/?utm_source=google&b=2&a=1')
 * // Returns: 'https://example.com/path?a=1&b=2'
 *
 * normalizeUrl('https://example.com/path/')
 * // Returns: 'https://example.com/path'
 *
 * normalizeUrl('https://example.com/')
 * // Returns: 'https://example.com/' (root path keeps trailing slash)
 * ```
 */
export function normalizeUrl(url: string, options: NormalizeUrlOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Parse URL - throws if invalid
  const parsed = new URL(url);

  // Lowercase protocol
  parsed.protocol = parsed.protocol.toLowerCase();

  // Lowercase and optionally remove www. from hostname
  let hostname = parsed.hostname.toLowerCase();
  if (opts.removeWww && hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }
  parsed.hostname = hostname;

  // Normalize pathname - decode and re-encode for consistency
  let pathname = parsed.pathname;

  // Remove trailing slash (but keep for root path '/')
  if (pathname !== '/' && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Lowercase the pathname for case-insensitive matching
  // Note: Some servers are case-sensitive, but for dedup we treat as case-insensitive
  pathname = pathname.toLowerCase();
  parsed.pathname = pathname;

  // Remove hash/fragment if requested
  if (opts.removeHash) {
    parsed.hash = '';
  }

  // Handle query parameters
  if (opts.removeTrackingParams || opts.sortQueryParams) {
    const paramsToRemove = new Set([
      ...(opts.removeTrackingParams ? TRACKING_PARAMS : []),
      ...opts.additionalParamsToRemove,
    ]);

    // Get all params, filter, and optionally sort
    const entries = Array.from(parsed.searchParams.entries());
    const filteredEntries = entries.filter(([key]) => !paramsToRemove.has(key.toLowerCase()));

    // Clear existing params
    parsed.search = '';

    // Re-add filtered (and optionally sorted) params
    const sortedEntries = opts.sortQueryParams
      ? filteredEntries.sort(([a], [b]) => a.localeCompare(b))
      : filteredEntries;

    sortedEntries.forEach(([key, value]) => {
      parsed.searchParams.append(key, value);
    });
  }

  return parsed.toString();
}

/**
 * Extracts the domain from a URL.
 *
 * @param url - The URL to extract domain from
 * @param includeSubdomain - Whether to include subdomain (default: false)
 * @returns The domain (e.g., 'example.com' or 'blog.example.com')
 * @throws Error if URL is invalid
 *
 * @example
 * ```typescript
 * extractDomain('https://blog.example.com/post')
 * // Returns: 'example.com'
 *
 * extractDomain('https://blog.example.com/post', true)
 * // Returns: 'blog.example.com'
 * ```
 */
export function extractDomain(url: string, includeSubdomain = false): string {
  const parsed = new URL(url);
  let hostname = parsed.hostname.toLowerCase();

  // Remove www. prefix
  if (hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }

  if (includeSubdomain) {
    return hostname;
  }

  // Extract root domain (last two parts, or three for .co.uk etc.)
  const parts = hostname.split('.');

  // Handle special TLDs like .co.uk, .com.au
  const specialTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'org.uk'];
  const lastTwo = parts.slice(-2).join('.');

  if (specialTlds.includes(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  // Standard TLD - return last two parts
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostname;
}

/**
 * Checks if two URLs are duplicates after normalization.
 *
 * @param url1 - First URL
 * @param url2 - Second URL
 * @param options - Normalization options
 * @returns true if URLs normalize to the same string
 *
 * @example
 * ```typescript
 * areUrlsDuplicates(
 *   'https://example.com/path?utm_source=google',
 *   'https://www.example.com/path/'
 * )
 * // Returns: true
 * ```
 */
export function areUrlsDuplicates(
  url1: string,
  url2: string,
  options: NormalizeUrlOptions = {}
): boolean {
  try {
    return normalizeUrl(url1, options) === normalizeUrl(url2, options);
  } catch {
    return false;
  }
}

/**
 * Validates if a string is a valid URL.
 *
 * @param url - The string to validate
 * @returns true if the string is a valid URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a browser-safe external URL or null when the value should not be
 * exposed as a clickable link. Only HTTP(S) URLs without embedded credentials
 * are accepted.
 */
export function getSafeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Ensures a URL has a protocol, defaulting to https.
 *
 * @param url - The URL string (may or may not have protocol)
 * @returns URL with protocol
 *
 * @example
 * ```typescript
 * ensureProtocol('example.com/path')
 * // Returns: 'https://example.com/path'
 *
 * ensureProtocol('http://example.com')
 * // Returns: 'http://example.com'
 * ```
 */
export function ensureProtocol(url: string): string {
  const trimmed = url.trim();

  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }

  if (!trimmed.includes('://')) {
    return `https://${trimmed}`;
  }

  return trimmed;
}
