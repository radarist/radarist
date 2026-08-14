/**
 * @jest-environment node
 *
 * OBS-001 — the declaration envelope that carries a function's BUSINESS outcome
 * to the transport recorder.
 *
 * The properties under test are the ones that keep the fix honest:
 * - a malformed or missing declaration degrades to *undeclared*, never to a
 *   coerced success;
 * - the reserved key never reaches the persisted `output`, so readers that
 *   already parse `JobRun.output` by schema (the Defense Minister join) see the
 *   same shape they always did;
 * - a transport-`interrupted` run gets NO outcome, because a runtime that died
 *   with its queue state gone cannot prove the work failed either.
 */

import {
  DOMAIN_OUTCOME_FIELD,
  DOMAIN_OUTCOME_SOURCES,
  MAX_DOMAIN_OUTCOME_REASON_LENGTH,
  declareDomainOutcome,
  isDomainOutcomeSource,
  normalizeDomainOutcomeReason,
  readDomainOutcomeDeclaration,
  resolveJobRunDomainFields,
  splitDomainOutcome,
} from '../domain-outcome';

describe('declareDomainOutcome', () => {
  it('attaches the declaration under the reserved key without disturbing the data', () => {
    const declared = declareDomainOutcome({ missionId: 'm-1', duration: 42 }, { outcome: 'failed' });
    expect(declared.missionId).toBe('m-1');
    expect(declared.duration).toBe(42);
    expect(declared[DOMAIN_OUTCOME_FIELD]).toEqual({ outcome: 'failed' });
  });

  it('keeps a bounded, sanitised reason', () => {
    const declared = declareDomainOutcome({}, { outcome: 'partial', reason: '  children\n\nfailed  ' });
    expect(declared[DOMAIN_OUTCOME_FIELD]).toEqual({ outcome: 'partial', reason: 'children failed' });
  });

  it('omits a reason that reduces to nothing rather than persisting an empty string', () => {
    expect(declareDomainOutcome({}, { outcome: 'success', reason: '   ' })[DOMAIN_OUTCOME_FIELD]).toEqual({
      outcome: 'success',
    });
  });

  it('cannot be shadowed by a same-named domain field', () => {
    const declared = declareDomainOutcome(
      { [DOMAIN_OUTCOME_FIELD]: { outcome: 'success' } } as Record<string, unknown>,
      { outcome: 'failed' }
    );
    expect(declared[DOMAIN_OUTCOME_FIELD]).toEqual({ outcome: 'failed' });
  });
});

describe('normalizeDomainOutcomeReason', () => {
  it('strips control characters that would corrupt a log line', () => {
    expect(normalizeDomainOutcomeReason('a\u0000b\u0001c\u007fd')).toBe('a b c d');
  });

  it('bounds the length', () => {
    const long = 'x'.repeat(MAX_DOMAIN_OUTCOME_REASON_LENGTH + 50);
    expect(normalizeDomainOutcomeReason(long)).toHaveLength(MAX_DOMAIN_OUTCOME_REASON_LENGTH);
  });

  it('rejects non-strings', () => {
    for (const bogus of [undefined, null, 7, {}, []]) expect(normalizeDomainOutcomeReason(bogus)).toBeUndefined();
  });
});

describe('readDomainOutcomeDeclaration', () => {
  it('reads a well-formed declaration', () => {
    expect(readDomainOutcomeDeclaration({ [DOMAIN_OUTCOME_FIELD]: { outcome: 'skipped', reason: 'no-gaps' } })).toEqual(
      {
        outcome: 'skipped',
        reason: 'no-gaps',
      }
    );
  });

  it('fails closed on every malformed shape instead of coercing an outcome', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'success',
      42,
      [],
      {},
      { [DOMAIN_OUTCOME_FIELD]: null },
      { [DOMAIN_OUTCOME_FIELD]: 'success' },
      { [DOMAIN_OUTCOME_FIELD]: [] },
      { [DOMAIN_OUTCOME_FIELD]: {} },
      { [DOMAIN_OUTCOME_FIELD]: { outcome: 'completed' } },
      { [DOMAIN_OUTCOME_FIELD]: { outcome: true } },
    ];
    for (const value of malformed) expect(readDomainOutcomeDeclaration(value)).toBeUndefined();
  });
});

describe('splitDomainOutcome', () => {
  it('removes the reserved key from the output that gets persisted', () => {
    const returned = declareDomainOutcome({ entityId: 'e-1', status: 'verified' }, { outcome: 'success' });
    const { declaration, output } = splitDomainOutcome(returned);
    expect(declaration).toEqual({ outcome: 'success' });
    expect(output).toEqual({ entityId: 'e-1', status: 'verified' });
    expect(Object.keys(output as object)).not.toContain(DOMAIN_OUTCOME_FIELD);
  });

  it('passes an undeclared value through untouched', () => {
    const value = { a: 1 };
    const { declaration, output } = splitDomainOutcome(value);
    expect(declaration).toBeUndefined();
    expect(output).toBe(value);
  });

  it('passes scalars and arrays through untouched', () => {
    expect(splitDomainOutcome(7)).toEqual({ declaration: undefined, output: 7 });
    expect(splitDomainOutcome(undefined)).toEqual({ declaration: undefined, output: undefined });
    expect(splitDomainOutcome(['a'])).toEqual({ declaration: undefined, output: ['a'] });
  });
});

describe('resolveJobRunDomainFields', () => {
  it('records an undeclared clean run as undeclared — NOT as success', () => {
    // The whole point of OBS-001: a transport-completed run with no declaration
    // must not be counted as a business success anywhere.
    expect(resolveJobRunDomainFields({ transport: 'completed' })).toEqual({ domainOutcomeSource: 'undeclared' });
  });

  it('persists a declared failure alongside a completed transport', () => {
    expect(
      resolveJobRunDomainFields({
        transport: 'completed',
        declaration: { outcome: 'failed', reason: 'no-deliverable' },
      })
    ).toEqual({
      domainOutcome: 'failed',
      domainOutcomeSource: 'declared',
      domainOutcomeReason: 'no-deliverable',
    });
  });

  it('entails a domain failure from an exhausted transport failure', () => {
    expect(resolveJobRunDomainFields({ transport: 'failed' })).toEqual({
      domainOutcome: 'failed',
      domainOutcomeSource: 'transport-failure',
    });
  });

  it('lets a declaration win over a transport failure (real recovered output)', () => {
    expect(resolveJobRunDomainFields({ transport: 'failed', declaration: { outcome: 'partial' } })).toEqual({
      domainOutcome: 'partial',
      domainOutcomeSource: 'declared',
    });
  });

  it('maps a server-side cancellation with no declaration possible', () => {
    expect(resolveJobRunDomainFields({ transport: 'cancelled' })).toEqual({
      domainOutcome: 'cancelled',
      domainOutcomeSource: 'transport-cancellation',
    });
  });

  it('leaves an interrupted run with NO outcome — unknowable, not failed', () => {
    expect(resolveJobRunDomainFields({ transport: 'interrupted' })).toEqual({
      domainOutcomeSource: 'transport-interrupted',
    });
  });

  it('exposes a closed source vocabulary', () => {
    for (const source of DOMAIN_OUTCOME_SOURCES) expect(isDomainOutcomeSource(source)).toBe(true);
    expect(isDomainOutcomeSource('guessed')).toBe(false);
  });
});
