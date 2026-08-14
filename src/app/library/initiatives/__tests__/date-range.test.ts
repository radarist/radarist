import { formatDate, formatDateRange } from '../date-range';

describe('formatDateRange', () => {
  // Local-time constructors so Intl (which formats in the local zone)
  // can never flip the calendar day regardless of the CI machine's TZ.
  const jan1_2026 = new Date(2026, 0, 1).getTime();
  const dec31_2026 = new Date(2026, 11, 31).getTime();

  it('formats both dates as a single en-dash range', () => {
    expect(formatDateRange(jan1_2026, dec31_2026)).toBe('Jan 1, 2026 – Dec 31, 2026');
  });

  it('falls back to the single start date when end is missing (never a dangling dash)', () => {
    expect(formatDateRange(jan1_2026, undefined)).toBe('Jan 1, 2026');
  });

  it('falls back to the single end date when start is missing (never a dangling dash)', () => {
    expect(formatDateRange(undefined, dec31_2026)).toBe('Dec 31, 2026');
  });

  it('returns an em dash when both dates are missing (CONV-EMPTY)', () => {
    expect(formatDateRange(undefined, undefined)).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats a timestamp as "Mon D, YYYY"', () => {
    expect(formatDate(new Date(2026, 5, 26).getTime())).toBe('Jun 26, 2026');
  });

  it('returns an em dash for a missing timestamp', () => {
    expect(formatDate(undefined)).toBe('—');
  });
});
