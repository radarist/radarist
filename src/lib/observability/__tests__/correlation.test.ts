import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_LENGTH,
  InvalidCorrelationIdError,
  correlationIdFromHeaders,
  createCorrelationId,
  isCorrelationId,
  parseCorrelationId,
  parseMissionId,
  MISSION_ID_MAX_LENGTH,
  resolveCorrelationId,
  withCorrelationIdHeader,
} from '../correlation';

const VALID_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

describe('relation correlation contract', () => {
  it('generates bounded opaque UUIDv4 identifiers', () => {
    const first = createCorrelationId();
    const second = createCorrelationId();

    expect(first).toHaveLength(CORRELATION_ID_LENGTH);
    expect(isCorrelationId(first)).toBe(true);
    expect(isCorrelationId(second)).toBe(true);
    expect(second).not.toBe(first);
  });

  it('accepts only the exact lowercase corr UUIDv4 format', () => {
    expect(parseCorrelationId(VALID_ID)).toBe(VALID_ID);
    expect(parseCorrelationId(VALID_ID.toUpperCase())).toBeNull();
    expect(parseCorrelationId('corr_123e4567-e89b-12d3-a456-426614174000')).toBeNull();
    expect(parseCorrelationId(`${VALID_ID}secret`)).toBeNull();
    expect(parseCorrelationId('')).toBeNull();
    expect(parseCorrelationId(null)).toBeNull();
  });

  it('forwards valid IDs, generates only when absent, and rejects malformed input', () => {
    expect(resolveCorrelationId(VALID_ID)).toBe(VALID_ID);
    expect(isCorrelationId(resolveCorrelationId())).toBe(true);
    expect(() => resolveCorrelationId('customer@example.com')).toThrow(InvalidCorrelationIdError);
  });

  it('distinguishes an absent HTTP header from a malformed supplied header', () => {
    expect(isCorrelationId(correlationIdFromHeaders(new Headers()))).toBe(true);
    expect(
      correlationIdFromHeaders(new Headers({ [CORRELATION_ID_HEADER]: VALID_ID }))
    ).toBe(VALID_ID);
    expect(
      correlationIdFromHeaders(new Headers({ [CORRELATION_ID_HEADER]: 'private search text' }))
    ).toBeNull();
  });

  it('exposes a validated ID through the public response header', () => {
    const response = withCorrelationIdHeader(new Response(null), VALID_ID);

    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(VALID_ID);
    expect(() => withCorrelationIdHeader(new Response(null), 'not-an-id')).toThrow(
      InvalidCorrelationIdError
    );
  });
});

describe('parseMissionId (ARUN-023 bounded mission correlation)', () => {
  it('accepts a generated-shaped synthetic mission id', () => {
    expect(parseMissionId('mission-fixture-correlation-a1b2c3')).toBe('mission-fixture-correlation-a1b2c3');
  });

  it('trims surrounding whitespace', () => {
    expect(parseMissionId('  mission-1-abc  ')).toBe('mission-1-abc');
  });

  it.each([
    ['a path separator', 'missions/mission-1'],
    ['a parent-directory segment', '../../etc/passwd'],
    ['a dot segment', '.'],
    ['a Firestore reserved form', '__name__'],
    ['prose', 'the mission the user asked about'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(parseMissionId(value)).toBeNull();
  });

  it.each([[42], [null], [undefined], [{}], [['mission-1']]])('rejects the non-string %p', (value) => {
    expect(parseMissionId(value)).toBeNull();
  });

  it('rejects a value longer than the bound', () => {
    expect(parseMissionId('m'.repeat(MISSION_ID_MAX_LENGTH))).toHaveLength(MISSION_ID_MAX_LENGTH);
    expect(parseMissionId('m'.repeat(MISSION_ID_MAX_LENGTH + 1))).toBeNull();
  });
});
