import { safeFormatDate } from '../safe-format-date';

describe('safeFormatDate', () => {
  it('formats a valid date with the given pattern', () => {
    // Noon UTC avoids day-boundary flakiness across local timezones.
    expect(safeFormatDate('2026-07-05T12:00:00.000Z', 'MMM d, yyyy')).toBe('Jul 5, 2026');
  });

  it('returns the "—" fallback on an invalid date string', () => {
    expect(safeFormatDate('not-a-date', 'MMM d, yyyy')).toBe('—');
  });

  it('returns a custom fallback when provided', () => {
    expect(safeFormatDate('not-a-date', 'MMM d, yyyy', 'N/A')).toBe('N/A');
  });

  it('treats an empty string as invalid and falls back', () => {
    expect(safeFormatDate('', 'MMM d, yyyy')).toBe('—');
  });
});
