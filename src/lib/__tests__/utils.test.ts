/**
 * Tests for lib/utils.ts
 *
 * Pure utility functions:
 * - cn: Tailwind class merging
 * - formatBytes: byte size formatting
 * - formatRelativeTime: relative timestamp formatting
 * - formatDate: date string formatting
 * - formatDateTime: date+time string formatting
 */

import { cn, formatBytes, formatRelativeTime, formatDate, formatDateTime } from '../utils';

// ============================================================================
// cn
// ============================================================================

describe('cn', () => {
  it('should merge simple class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('should handle no arguments', () => {
    expect(cn()).toBe('');
  });

  it('should handle undefined and null inputs', () => {
    expect(cn(undefined, null, 'foo')).toBe('foo');
  });

  it('should handle conditional class objects', () => {
    expect(cn({ 'text-red-500': true, 'text-blue-500': false })).toBe('text-red-500');
  });

  it('should resolve Tailwind conflicts (last wins)', () => {
    // twMerge resolves conflicts: p-4 overrides p-2
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('should handle array inputs', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });

  it('should handle mixed inputs', () => {
    const isActive = true;
    expect(cn('base', isActive && 'active', { disabled: false })).toBe('base active');
  });
});

// ============================================================================
// formatBytes
// ============================================================================

describe('formatBytes', () => {
  it('should return "0 Bytes" for 0', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('should format bytes below 1 KB', () => {
    expect(formatBytes(512)).toBe('512 Bytes');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('should use 2 decimal places by default', () => {
    expect(formatBytes(1500)).toBe('1.46 KB');
  });

  it('should respect custom decimal places', () => {
    expect(formatBytes(1500, 0)).toBe('1 KB');
    expect(formatBytes(1500, 3)).toBe('1.465 KB');
  });

  it('should clamp negative decimals to 0', () => {
    expect(formatBytes(1500, -1)).toBe('1 KB');
  });

  it('should format terabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });
});

// ============================================================================
// formatRelativeTime
// ============================================================================

describe('formatRelativeTime', () => {
  const now = Date.now();

  it('should return "just now" for less than 60 seconds ago', () => {
    expect(formatRelativeTime(now - 30 * 1000)).toBe('just now');
  });

  it('should return "just now" for 0 seconds ago', () => {
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('should format singular minute', () => {
    expect(formatRelativeTime(now - 60 * 1000)).toBe('1 minute ago');
  });

  it('should format plural minutes', () => {
    expect(formatRelativeTime(now - 5 * 60 * 1000)).toBe('5 minutes ago');
  });

  it('should format singular hour', () => {
    expect(formatRelativeTime(now - 60 * 60 * 1000)).toBe('1 hour ago');
  });

  it('should format plural hours', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000)).toBe('3 hours ago');
  });

  it('should format singular day', () => {
    expect(formatRelativeTime(now - 24 * 60 * 60 * 1000)).toBe('1 day ago');
  });

  it('should format plural days', () => {
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000)).toBe('3 days ago');
  });

  it('should format singular week', () => {
    expect(formatRelativeTime(now - 7 * 24 * 60 * 60 * 1000)).toBe('1 week ago');
  });

  it('should format plural weeks', () => {
    expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe('2 weeks ago');
  });

  it('should format singular month', () => {
    expect(formatRelativeTime(now - 30 * 24 * 60 * 60 * 1000)).toBe('1 month ago');
  });

  it('should format plural months', () => {
    expect(formatRelativeTime(now - 60 * 24 * 60 * 60 * 1000)).toBe('2 months ago');
  });

  it('should format singular year', () => {
    expect(formatRelativeTime(now - 365 * 24 * 60 * 60 * 1000)).toBe('1 year ago');
  });

  it('should format plural years', () => {
    expect(formatRelativeTime(now - 2 * 365 * 24 * 60 * 60 * 1000)).toBe('2 years ago');
  });
});

// ============================================================================
// formatDate
// ============================================================================

describe('formatDate', () => {
  it('should format a known timestamp to a readable date string', () => {
    // Jan 15, 2026 00:00:00 UTC
    const timestamp = new Date('2026-01-15T00:00:00.000Z').getTime();
    const result = formatDate(timestamp);
    // The output depends on locale but should include "2026" and "15"
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/15/);
  });

  it('should produce a non-empty string for any valid timestamp', () => {
    expect(formatDate(0).length).toBeGreaterThan(0);
    expect(formatDate(Date.now()).length).toBeGreaterThan(0);
  });

  it('should format January correctly', () => {
    // 2026-01-01 UTC
    const timestamp = new Date('2026-01-01T00:00:00.000Z').getTime();
    const result = formatDate(timestamp);
    expect(result).toMatch(/Jan/);
  });
});

// ============================================================================
// formatDateTime
// ============================================================================

describe('formatDateTime', () => {
  it('should include year in output', () => {
    const timestamp = new Date('2026-06-15T14:30:00.000Z').getTime();
    const result = formatDateTime(timestamp);
    expect(result).toMatch(/2026/);
  });

  it('should produce a non-empty string for any valid timestamp', () => {
    expect(formatDateTime(Date.now()).length).toBeGreaterThan(0);
    expect(formatDateTime(0).length).toBeGreaterThan(0);
  });

  it('should include time information (AM/PM)', () => {
    const timestamp = new Date('2026-06-15T14:30:00.000Z').getTime();
    const result = formatDateTime(timestamp);
    // en-US locale with hour/minute should include AM or PM
    expect(result).toMatch(/[AP]M/);
  });

  it('should differ from formatDate output (has time info)', () => {
    const timestamp = new Date('2026-06-15T14:30:00.000Z').getTime();
    const dateOnly = formatDate(timestamp);
    const dateTime = formatDateTime(timestamp);
    // formatDateTime includes time so it should be longer
    expect(dateTime.length).toBeGreaterThan(dateOnly.length);
  });
});

export {};
