/**
 * @file company-utils.ts
 * @description Utility functions for company operations in the Scouting feature.
 *
 * This module provides helper functions for common operations like logo fetching,
 * URL validation and data formatting.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import type { Company, CompanySize, CompanyStage, CompanyType, CompanyIndustry } from '@/lib/types';
import { normalizeIndustries } from '@/lib/normalize-industries';
import { createLogger } from '@/lib/logger';
const log = createLogger('company-utils');

/**
 * Fetches a company logo from an external API service.
 *
 * Strategy:
 * 1. Try Clearbit Logo API (https://logo.clearbit.com/:domain)
 * 2. Fallback to a placeholder or initials-based avatar
 *
 * Note: Clearbit's free tier has rate limits. For production, consider:
 * - Brandfetch API (https://brandfetch.com)
 * - Google Favicon service
 * - Local caching to reduce API calls
 *
 * @param websiteUrl - The company website URL
 * @returns Promise resolving to the logo URL or null if not found
 *
 * @example
 * const logoUrl = await fetchCompanyLogo("https://www.datadog.com");
 * if (logoUrl) {
 *   console.log(`Logo: ${logoUrl}`);
 * }
 */
export async function fetchCompanyLogo(websiteUrl: string): Promise<string | null> {
  try {
    const domain = extractDomain(websiteUrl);
    if (!domain) return null;

    // Strategy: Return Clearbit URL directly.
    // We cannot check HEAD from client-side due to CORS.
    // The UI should handle image load errors and fallback.
    return `https://logo.clearbit.com/${domain}`;
  } catch (error) {
    log.error('Error fetching company logo', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Extracts the domain from a URL.
 * Handles various URL formats and returns just the domain name.
 *
 * @param url - The URL to extract domain from
 * @returns The domain name or null if invalid
 *
 * @example
 * extractDomain("https://www.datadog.com/products/apm")  // => "datadog.com"
 * extractDomain("http://github.com")                     // => "github.com"
 * extractDomain("invalid-url")                           // => null
 */
export function extractDomain(url: string): string | null {
  try {
    // Add protocol if missing
    let fullUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fullUrl = 'https://' + url;
    }

    const urlObj = new URL(fullUrl);
    let hostname = urlObj.hostname;

    // Remove www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }

    return hostname;
  } catch {
    return null;
  }
}

/**
 * Validates a website URL.
 * Ensures the URL is properly formatted and uses http/https protocol.
 *
 * @param url - The URL to validate
 * @returns True if valid, false otherwise
 *
 * @example
 * validateWebsite("https://www.datadog.com")  // => true
 * validateWebsite("datadog.com")              // => true (will add https://)
 * validateWebsite("not a url")                // => false
 */
export function validateWebsite(url: string): boolean {
  try {
    // Add protocol if missing
    let fullUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fullUrl = 'https://' + url;
    }

    const urlObj = new URL(fullUrl);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalizes a website URL to ensure consistent storage.
 * Adds https:// if no protocol is provided.
 *
 * @param url - The URL to normalize
 * @returns Normalized URL
 *
 * @example
 * normalizeWebsite("datadog.com")              // => "https://datadog.com"
 * normalizeWebsite("http://datadog.com")       // => "http://datadog.com"
 * normalizeWebsite("https://www.datadog.com")  // => "https://www.datadog.com"
 */
export function normalizeWebsite(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url;
  }
  return url;
}

/**
 * Formats company size category into a human-readable string with employee range.
 * Updated in Phase 4 to use new enum values.
 *
 * @param size - The company size category
 * @returns Formatted string with employee range
 *
 * @example
 * formatCompanySize("micro")      // => "Micro (1-9 employees)"
 * formatCompanySize("small")      // => "Small (10-49 employees)"
 * formatCompanySize("enterprise") // => "Enterprise (>1000 employees)"
 */
export function formatCompanySize(size: CompanySize): string {
  const sizeMap: Record<CompanySize, string> = {
    micro: 'Micro (1-9 employees)',
    small: 'Small (10-49 employees)',
    medium: 'Medium (50-249 employees)',
    large: 'Large (250-999 employees)',
    enterprise: 'Enterprise (>1000 employees)',
  };
  return sizeMap[size] || size;
}

/**
 * Gets a color class for company status badges.
 * Follows the design system color palette.
 *
 * @param status - The company status
 * @returns Tailwind CSS class names for badge styling
 *
 * @example
 * <Badge className={getStatusColor("Partner")}>Partner</Badge>
 */
export function getStatusColor(status: string): string {
  const colorMap: Record<string, string> = {
    Watching: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
    Contacted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
    Partner: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    Rejected: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  };
  return colorMap[status] || 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
}

/**
 * Gets a color class for relationship type badges.
 *
 * @param relationshipType - The relationship type
 * @returns Tailwind CSS class names for badge styling
 */
export function getRelationshipTypeColor(relationshipType: string): string {
  const colorMap: Record<string, string> = {
    Vendor: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
    User: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
    Partner: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    Competitor: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  };
  return colorMap[relationshipType] || 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
}

/**
 * Generates initials from a company name for avatar fallbacks.
 *
 * @param companyName - The company name
 * @returns Up to 2 uppercase initials
 *
 * @example
 * getCompanyInitials("Datadog")              // => "D"
 * getCompanyInitials("Amazon Web Services")  // => "AW"
 * getCompanyInitials("IBM")                  // => "IB"
 */
export function getCompanyInitials(companyName: string): string {
  const words = companyName.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].substring(0, 2).toUpperCase();
  }
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}
