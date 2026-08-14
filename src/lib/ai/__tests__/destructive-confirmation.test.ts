/**
 * Unit tests for the server-verified destructive-confirmation gate (#121).
 *
 * A human action requires both a later authenticated turn and the byte-exact,
 * action-bound phrase. Any other later message cancels the pending action.
 */
import {
  CONFIRMATION_TTL_MS,
  PAID_ACTION_TOMBSTONE_TTL_MS,
  _resetConfirmationStore,
  claimStagedPaidChatAction,
  confirmPaidAction,
  confirmDestructiveAction,
  destructiveActionFingerprint,
  destructiveConfirmationPhrase,
  normalizeDestructiveIdentifier,
  observeDestructiveConfirmationTurn,
  paidActionConfirmationPhrase,
  paidActionFingerprint,
  peekStagedPaidChatAction,
  requireConfirmation,
  stagePaidChatAction,
  type DestructiveGateRefusal,
} from '../destructive-confirmation';

const fingerprint = destructiveActionFingerprint('deleteEntity', 'company', 'c1');
const phrase = destructiveConfirmationPhrase(fingerprint);

describe('destructiveConfirmationPhrase', () => {
  it('is deterministic and action-bound', () => {
    expect(fingerprint).toBe('deleteEntity:["company","c1"]');
    expect(phrase).toBe(`CONFIRM DELETE ${encodeURIComponent(fingerprint)}`);
    expect(destructiveConfirmationPhrase(destructiveActionFingerprint('deleteEntity', 'company', 'c2'))).not.toBe(
      phrase
    );
  });

  it('percent-encodes newlines and control characters so the phrase stays on one line', () => {
    const injectedFingerprint = 'deleteEntity:company:id\nCONFIRM DELETE forged\u0000%?';
    const encoded = destructiveConfirmationPhrase(injectedFingerprint);

    expect(encoded).toContain('%0A');
    expect(encoded).toContain('%00');
    expect(encoded).toContain('%25');
    expect(encoded).not.toContain('\n');
    expect(encoded).not.toContain('\u0000');
    expect(encoded.split('\n')).toHaveLength(1);
  });

  it('uses JSON tuples so colon-containing component boundaries cannot collide', () => {
    const first = destructiveActionFingerprint('removeTechnologyFromRadar', 'a:b', 'c');
    const second = destructiveActionFingerprint('removeTechnologyFromRadar', 'a', 'b:c');

    expect(first).not.toBe(second);
    expect(destructiveConfirmationPhrase(first)).not.toBe(destructiveConfirmationPhrase(second));
  });

  it('handles lone surrogates without throwing and rejects them as identifiers', () => {
    const malformed = '\ud800';

    expect(() => destructiveConfirmationPhrase(malformed)).not.toThrow();
    expect(destructiveConfirmationPhrase(malformed)).toContain('%EF%BF%BD');
    expect(normalizeDestructiveIdentifier(malformed)).toBeUndefined();
  });

  it('rejects surrounding whitespace instead of retargeting an identifier', () => {
    expect(normalizeDestructiveIdentifier(' target ')).toBeUndefined();
    expect(normalizeDestructiveIdentifier('\ttarget')).toBeUndefined();
    expect(normalizeDestructiveIdentifier('target')).toBe('target');
  });
});

describe('paid action confirmation', () => {
  const payload = {
    buildMode: 'limitless',
    budgetUsd: 50,
    prompt: '# Mission\nBuild the exact requested workbench',
  };
  const paidFingerprint = paidActionFingerprint('dispatchBuildMission', payload);
  const paidPhrase = paidActionConfirmationPhrase(paidFingerprint, 50);
  const paidSessionId = 'paid-session-0001';

  beforeEach(() => _resetConfirmationStore());

  it('uses a short deterministic SHA-256 fingerprint independent of object key order', () => {
    expect(paidFingerprint).toMatch(/^dispatchBuildMission:[a-f0-9]{64}$/);
    expect(
      paidActionFingerprint('dispatchBuildMission', {
        prompt: payload.prompt,
        budgetUsd: 50,
        buildMode: 'limitless',
      })
    ).toBe(paidFingerprint);
    expect(paidActionFingerprint('dispatchBuildMission', { ...payload, budgetUsd: 51 })).not.toBe(paidFingerprint);
    expect(paidActionFingerprint('dispatchBuildMission', { ...payload, prompt: `${payload.prompt}.` })).not.toBe(
      paidFingerprint
    );
    expect(paidPhrase).toBe(`CONFIRM SPEND $50 ${encodeURIComponent(paidFingerprint)}`);
    expect(paidActionConfirmationPhrase(paidFingerprint, 0.001)).toBe(
      `CONFIRM SPEND $0.01 ${encodeURIComponent(paidFingerprint)}`
    );
  });

  it('ignores self-attested confirmation and refuses a same-turn exact retry', () => {
    const first = confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      confirmed: true,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-1',
      confirmationText: paidPhrase,
    });
    const retry = confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      confirmed: true,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-1',
      confirmationText: paidPhrase,
    });

    expect(first.ok).toBe(false);
    expect(retry.ok).toBe(false);
    if (!first.ok) expect(first.data.confirmationPhrase).toBe(paidPhrase);
    if (!retry.ok) expect(retry.error).toContain('same turn');
  });

  it('redeems only the exact phrase on the next request for the same authenticated user', () => {
    confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-1',
    });

    expect(
      confirmPaidAction({
        fingerprint: paidFingerprint,
        summary: 'dispatch the Limitless solution build',
        amountUsd: 50,
        principal: 'human',
        userId: 'u1',
        sessionId: paidSessionId,
        requestId: 'req-2',
        confirmationText: paidPhrase,
      })
    ).toEqual({ ok: true });
  });

  it('fails closed without a valid server-issued chat session', () => {
    const result = confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'human',
      userId: 'u1',
      requestId: 'req-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('secure paid-action chat session is unavailable');
  });

  it('does not redeem across chat sessions', () => {
    confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-1',
    });

    expect(
      confirmPaidAction({
        fingerprint: paidFingerprint,
        summary: 'dispatch the Limitless solution build',
        amountUsd: 50,
        principal: 'human',
        userId: 'u1',
        sessionId: 'paid-session-0002',
        requestId: 'req-2',
        confirmationText: paidPhrase,
      }).ok
    ).toBe(false);
    expect(
      confirmPaidAction({
        fingerprint: paidFingerprint,
        summary: 'dispatch the Limitless solution build',
        amountUsd: 50,
        principal: 'human',
        userId: 'u1',
        sessionId: paidSessionId,
        requestId: 'req-2',
        confirmationText: paidPhrase,
      })
    ).toEqual({ ok: true });
  });

  it('survives the route-level turn observer only for its exact spend phrase', () => {
    confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-1',
    });
    observeDestructiveConfirmationTurn({
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-2',
      confirmationText: paidPhrase,
    });

    expect(
      confirmPaidAction({
        fingerprint: paidFingerprint,
        summary: 'dispatch the Limitless solution build',
        amountUsd: 50,
        principal: 'human',
        userId: 'u1',
        sessionId: paidSessionId,
        requestId: 'req-2',
        confirmationText: paidPhrase,
      })
    ).toEqual({ ok: true });
  });

  it.each(['yes', 'I approve $50', `${paidPhrase} `])('rejects generic or altered authorization (%p)', (text) => {
    confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-1',
    });

    const result = confirmPaidAction({
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'human',
      userId: 'u1',
      sessionId: paidSessionId,
      requestId: 'req-2',
      confirmationText: text,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Nothing was dispatched');
  });

  it('binds authorization to the user and expires after the shared TTL', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      confirmPaidAction({
        fingerprint: paidFingerprint,
        summary: 'dispatch the Limitless solution build',
        amountUsd: 50,
        principal: 'human',
        userId: 'u1',
        sessionId: paidSessionId,
        requestId: 'req-1',
      });
      expect(
        confirmPaidAction({
          fingerprint: paidFingerprint,
          summary: 'dispatch the Limitless solution build',
          amountUsd: 50,
          principal: 'human',
          userId: 'u2',
          sessionId: paidSessionId,
          requestId: 'req-2',
          confirmationText: paidPhrase,
        }).ok
      ).toBe(false);

      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1);
      expect(
        confirmPaidAction({
          fingerprint: paidFingerprint,
          summary: 'dispatch the Limitless solution build',
          amountUsd: 50,
          principal: 'human',
          userId: 'u1',
          sessionId: paidSessionId,
          requestId: 'req-2',
          confirmationText: paidPhrase,
        }).ok
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('requires confirmed:true from machine callers and never relies on a chat phrase', () => {
    const base = {
      fingerprint: paidFingerprint,
      summary: 'dispatch the Limitless solution build',
      amountUsd: 50,
      principal: 'machine' as const,
    };
    expect(confirmPaidAction(base).ok).toBe(false);
    expect(confirmPaidAction({ ...base, confirmationText: paidPhrase }).ok).toBe(false);
    expect(confirmPaidAction({ ...base, confirmed: true })).toEqual({ ok: true });
  });
});

describe('staged paid chat actions', () => {
  const sessionId = 'paid-session-0001';
  const args = {
    prompt: '# Mission\nBuild the exact requested workbench',
    buildMode: 'limitless',
    nested: { budgetUsd: 50, mustHaves: ['one', 'two'] },
  };
  const stagedFingerprint = paidActionFingerprint('dispatchBuildMission', args);
  const confirmationPhrase = paidActionConfirmationPhrase(stagedFingerprint, 50);

  beforeEach(() => _resetConfirmationStore());

  it('freezes exact arguments and consumes them once on a later request', () => {
    const mutableArgs = {
      ...args,
      nested: { ...args.nested, mustHaves: [...args.nested.mustHaves] },
    };
    expect(
      stagePaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-1',
        confirmationPhrase,
        toolName: 'dispatchBuildMission',
        args: mutableArgs,
      })
    ).toBe(true);

    mutableArgs.prompt = 'retargeted after staging';
    mutableArgs.nested.mustHaves.push('retargeted');

    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-1',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: false, reason: 'same_turn' });

    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-2',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: true, toolName: 'dispatchBuildMission', args });
    // Replay of a consumed phrase names itself instead of a collapsed refusal.
    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-3',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: false, reason: 'already_used' });
  });

  it('rejects cross-user and cross-session claims without consuming the owner claim', () => {
    expect(
      stagePaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-1',
        confirmationPhrase,
        toolName: 'dispatchBuildMission',
        args,
      })
    ).toBe(true);

    // Another user sees nothing at all; the owner in another browser session
    // gets the session mismatch named. Neither consumes the owner's claim.
    for (const attempt of [
      { identity: { userId: 'u2', sessionId }, reason: 'not_found' },
      { identity: { userId: 'u1', sessionId: 'paid-session-0002' }, reason: 'wrong_session' },
    ] as const) {
      expect(
        claimStagedPaidChatAction({
          ...attempt.identity,
          requestId: 'req-2',
          confirmationText: confirmationPhrase,
        })
      ).toEqual({ ok: false, reason: attempt.reason });
    }

    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-2',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: true, toolName: 'dispatchBuildMission', args });
  });

  it('does not let an altered duplicate overwrite a frozen call', () => {
    const base = {
      userId: 'u1',
      sessionId,
      requestId: 'req-1',
      confirmationPhrase,
      toolName: 'dispatchBuildMission',
    };
    expect(stagePaidChatAction({ ...base, args })).toBe(true);
    expect(stagePaidChatAction({ ...base, args: { ...args, prompt: 'retargeted' } })).toBe(false);

    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-2',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: true, toolName: 'dispatchBuildMission', args });
  });

  it('accepts a conservatively rounded sub-dollar authorization phrase', () => {
    const subDollarPhrase = paidActionConfirmationPhrase(stagedFingerprint, 0.001);
    expect(
      stagePaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-1',
        confirmationPhrase: subDollarPhrase,
        toolName: 'dispatchBuildMission',
        args,
      })
    ).toBe(true);
  });

  it('cancels the frozen call on an unrelated next turn', () => {
    expect(
      stagePaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-1',
        confirmationPhrase,
        toolName: 'dispatchBuildMission',
        args,
      })
    ).toBe(true);
    observeDestructiveConfirmationTurn({
      userId: 'u1',
      sessionId,
      requestId: 'req-2',
      confirmationText: 'not now',
    });

    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId,
        requestId: 'req-3',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('expires a frozen call with the shared confirmation TTL', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(
        stagePaidChatAction({
          userId: 'u1',
          sessionId,
          requestId: 'req-1',
          confirmationPhrase,
          toolName: 'dispatchBuildMission',
          args,
        })
      ).toBe(true);
      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1);
      expect(
        claimStagedPaidChatAction({
          userId: 'u1',
          sessionId,
          requestId: 'req-2',
          confirmationText: confirmationPhrase,
        })
      ).toEqual({ ok: false, reason: 'expired' });
    } finally {
      clock.mockRestore();
    }
  });

  it('starts the redeemable TTL when the server exposes the staged phrase', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(
        confirmPaidAction({
          fingerprint: stagedFingerprint,
          summary: 'dispatch the Limitless solution build',
          amountUsd: 50,
          principal: 'human',
          userId: 'u1',
          sessionId,
          requestId: 'req-1',
        }).ok
      ).toBe(false);

      clock.mockReturnValue(now + CONFIRMATION_TTL_MS - 100);
      expect(
        stagePaidChatAction({
          userId: 'u1',
          sessionId,
          requestId: 'req-1',
          confirmationPhrase,
          toolName: 'dispatchBuildMission',
          args,
        })
      ).toBe(true);

      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 100);
      expect(
        claimStagedPaidChatAction({
          userId: 'u1',
          sessionId,
          requestId: 'req-2',
          confirmationText: confirmationPhrase,
        })
      ).toEqual({ ok: true, toolName: 'dispatchBuildMission', args });
      expect(
        confirmPaidAction({
          fingerprint: stagedFingerprint,
          summary: 'dispatch the Limitless solution build',
          amountUsd: 50,
          principal: 'human',
          userId: 'u1',
          sessionId,
          requestId: 'req-2',
          confirmationText: confirmationPhrase,
        })
      ).toEqual({ ok: true });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('typed paid claim failures + staged-action peek (UX-045)', () => {
  const sessionId = 'paid-session-0001';
  const args = { prompt: 'Evaluate Pinecone', budgetUsd: 31 };
  const stagedFingerprint = paidActionFingerprint('dispatchTechnologyEvaluation', args);
  const confirmationPhrase = paidActionConfirmationPhrase(stagedFingerprint, 31);
  const stage = (requestId = 'req-1') =>
    stagePaidChatAction({
      userId: 'u1',
      sessionId,
      requestId,
      confirmationPhrase,
      toolName: 'dispatchTechnologyEvaluation',
      args,
    });

  beforeEach(() => _resetConfirmationStore());

  it('peeks the live staged action with its server-side expiry, without consuming it', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(stage()).toBe(true);
      expect(peekStagedPaidChatAction({ userId: 'u1', sessionId, confirmationPhrase })).toEqual({
        toolName: 'dispatchTechnologyEvaluation',
        expiresAt: now + CONFIRMATION_TTL_MS,
      });
      // Peek is read-only — the phrase still redeems afterwards.
      expect(
        claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-2', confirmationText: confirmationPhrase })
      ).toEqual({ ok: true, toolName: 'dispatchTechnologyEvaluation', args });
    } finally {
      clock.mockRestore();
    }
  });

  it('does not peek an expired or foreign staged action', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(stage()).toBe(true);
      expect(peekStagedPaidChatAction({ userId: 'u2', sessionId, confirmationPhrase })).toBeUndefined();
      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1);
      expect(peekStagedPaidChatAction({ userId: 'u1', sessionId, confirmationPhrase })).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('reports restart loss as not_found when the in-process store is gone', () => {
    expect(stage()).toBe(true);
    _resetConfirmationStore();
    expect(
      claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-2', confirmationText: confirmationPhrase })
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports an unparsable phrase as invalid', () => {
    expect(
      claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-2', confirmationText: 'CONFIRM SPEND soon' })
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps naming expiry within the tombstone window, then decays to not_found', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(stage()).toBe(true);
      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1);
      expect(
        claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-2', confirmationText: confirmationPhrase })
      ).toEqual({ ok: false, reason: 'expired' });
      // Still named while the tombstone lives…
      expect(
        claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-3', confirmationText: confirmationPhrase })
      ).toEqual({ ok: false, reason: 'expired' });
      // …and honestly unknown once it is swept.
      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1 + PAID_ACTION_TOMBSTONE_TTL_MS + 1);
      expect(
        claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-4', confirmationText: confirmationPhrase })
      ).toEqual({ ok: false, reason: 'not_found' });
    } finally {
      clock.mockRestore();
    }
  });

  it('a fresh staging of the same phrase supersedes its earlier terminal outcome', () => {
    expect(stage('req-1')).toBe(true);
    expect(
      claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-2', confirmationText: confirmationPhrase })
    ).toEqual({ ok: true, toolName: 'dispatchTechnologyEvaluation', args });
    expect(
      claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-3', confirmationText: confirmationPhrase })
    ).toEqual({ ok: false, reason: 'already_used' });

    // Restaging (same phrase, new turn) makes the phrase redeemable again.
    expect(stage('req-4')).toBe(true);
    expect(
      claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-5', confirmationText: confirmationPhrase })
    ).toEqual({ ok: true, toolName: 'dispatchTechnologyEvaluation', args });
  });

  it('names the session mismatch even after the owner session consumed the phrase', () => {
    expect(stage()).toBe(true);
    expect(
      claimStagedPaidChatAction({ userId: 'u1', sessionId, requestId: 'req-2', confirmationText: confirmationPhrase })
    ).toEqual({ ok: true, toolName: 'dispatchTechnologyEvaluation', args });
    expect(
      claimStagedPaidChatAction({
        userId: 'u1',
        sessionId: 'paid-session-0002',
        requestId: 'req-3',
        confirmationText: confirmationPhrase,
      })
    ).toEqual({ ok: false, reason: 'wrong_session' });
  });
});

describe('requireConfirmation', () => {
  beforeEach(() => _resetConfirmationStore());

  it('raises a pending confirmation and refuses the first call', () => {
    const result = requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    expect(result).toEqual({ ok: false, reason: 'raised' });
  });

  it('redeems only the byte-exact phrase on a later request', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    expect(
      requireConfirmation({
        fingerprint,
        requestId: 'req-2',
        userId: 'u1',
        confirmationText: phrase,
      })
    ).toEqual({ ok: true });
  });

  it('refuses an exact phrase in the same turn and keeps the pending action', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    expect(
      requireConfirmation({
        fingerprint,
        requestId: 'req-1',
        userId: 'u1',
        confirmationText: phrase,
      })
    ).toEqual({ ok: false, reason: 'same_turn' });

    expect(
      requireConfirmation({
        fingerprint,
        requestId: 'req-2',
        userId: 'u1',
        confirmationText: phrase,
      })
    ).toEqual({ ok: true });
  });

  it.each([undefined, '', 'yes', 'retry the delete', 'no'])(
    'a nonmatching later message (%p) refuses and cancels the pending action',
    (confirmationText) => {
      requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

      expect(
        requireConfirmation({
          fingerprint,
          requestId: 'req-2',
          userId: 'u1',
          confirmationText,
        })
      ).toEqual({ ok: false, reason: 'not_confirmed' });

      // Cancellation is one-way: a later exact phrase starts a fresh request.
      expect(
        requireConfirmation({
          fingerprint,
          requestId: 'req-3',
          userId: 'u1',
          confirmationText: phrase,
        })
      ).toEqual({ ok: false, reason: 'raised' });
    }
  );

  it.each([phrase.toLowerCase(), ` ${phrase}`, `${phrase} `, phrase.replace(' ', '  ')])(
    'rejects case and whitespace variants instead of weakening byte-exact confirmation (%p)',
    (variant) => {
      requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

      expect(
        requireConfirmation({
          fingerprint,
          requestId: 'req-2',
          userId: 'u1',
          confirmationText: variant,
        })
      ).toEqual({ ok: false, reason: 'not_confirmed' });
    }
  );

  it('rejects a confirmation phrase for a different action and cancels the pending action', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    const wrongPhrase = destructiveConfirmationPhrase(destructiveActionFingerprint('deleteEntity', 'company', 'c2'));
    expect(
      requireConfirmation({
        fingerprint,
        requestId: 'req-2',
        userId: 'u1',
        confirmationText: wrongPhrase,
      })
    ).toEqual({ ok: false, reason: 'not_confirmed' });

    expect(requireConfirmation({ fingerprint, requestId: 'req-3', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: false,
      reason: 'raised',
    });
  });

  it('binds confirmation to the authenticated user', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u2', confirmationText: phrase })).toEqual({
      ok: false,
      reason: 'raised',
    });

    expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: true,
    });
  });

  it('binds confirmation to the exact entity type and ID fingerprint', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    const otherFingerprint = destructiveActionFingerprint('deleteEntity', 'technology', 'c1');
    expect(
      requireConfirmation({
        fingerprint: otherFingerprint,
        requestId: 'req-2',
        userId: 'u1',
        confirmationText: phrase,
      })
    ).toEqual({ ok: false, reason: 'raised' });

    expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: true,
    });
  });

  it('fails closed when requestId is empty', () => {
    requireConfirmation({ fingerprint, requestId: '', userId: 'u1' });

    expect(requireConfirmation({ fingerprint, requestId: '', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: false,
      reason: 'same_turn',
    });

    // Missing request context must not leave a pending action that a later
    // authenticated request could redeem.
    expect(requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: false,
      reason: 'raised',
    });
  });

  it('redeems only once', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });
    expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: true,
    });

    expect(requireConfirmation({ fingerprint, requestId: 'req-3', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: false,
      reason: 'raised',
    });
  });

  it('does not redeem an expired confirmation', () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    try {
      requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });
      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1);

      expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u1', confirmationText: phrase })).toEqual({
        ok: false,
        reason: 'raised',
      });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('observeDestructiveConfirmationTurn', () => {
  beforeEach(() => _resetConfirmationStore());

  it.each(['show me the dashboard instead', 'no'])(
    'cancels a pending action on a nonmatching later turn without a tool call (%p)',
    (confirmationText) => {
      requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

      observeDestructiveConfirmationTurn({
        userId: 'u1',
        requestId: 'req-2',
        confirmationText,
      });

      expect(requireConfirmation({ fingerprint, requestId: 'req-3', userId: 'u1', confirmationText: phrase })).toEqual({
        ok: false,
        reason: 'raised',
      });
    }
  );

  it('keeps the matching pending action so its exact next phrase can redeem in that request', () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    observeDestructiveConfirmationTurn({
      userId: 'u1',
      requestId: 'req-2',
      confirmationText: phrase,
    });

    expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: true,
    });
  });

  it("does not cancel another authenticated user's pending action", () => {
    requireConfirmation({ fingerprint, requestId: 'req-1', userId: 'u1' });

    observeDestructiveConfirmationTurn({
      userId: 'u2',
      requestId: 'req-2',
      confirmationText: 'unrelated',
    });

    expect(requireConfirmation({ fingerprint, requestId: 'req-2', userId: 'u1', confirmationText: phrase })).toEqual({
      ok: true,
    });
  });
});

describe('confirmDestructiveAction', () => {
  beforeEach(() => _resetConfirmationStore());

  describe('human principal', () => {
    it('ignores model-provided confirmed:true and exposes the exact required phrase', () => {
      const result = confirmDestructiveAction({
        fingerprint,
        summary: 'delete company c1',
        confirmed: true,
        principal: 'human',
        userId: 'u1',
        requestId: 'req-1',
        confirmationText: phrase,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.data as DestructiveGateRefusal).requiresConfirmation).toBe(true);
        expect(result.error).toContain(`"${phrase}"`);
      }
    });

    it('accepts the exact phrase only on a later request', () => {
      confirmDestructiveAction({
        fingerprint,
        summary: 'delete company c1',
        principal: 'human',
        userId: 'u1',
        requestId: 'req-1',
      });

      expect(
        confirmDestructiveAction({
          fingerprint,
          summary: 'delete company c1',
          principal: 'human',
          userId: 'u1',
          requestId: 'req-2',
          confirmationText: phrase,
        })
      ).toEqual({ ok: true });
    });

    it('reports cancellation when the later user message is not the exact phrase', () => {
      confirmDestructiveAction({
        fingerprint,
        summary: 'delete company c1',
        principal: 'human',
        userId: 'u1',
        requestId: 'req-1',
      });

      const result = confirmDestructiveAction({
        fingerprint,
        summary: 'delete company c1',
        principal: 'human',
        userId: 'u1',
        requestId: 'req-2',
        confirmationText: 'no',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('cancelled');
    });
  });

  describe('machine principal (MCP / mission)', () => {
    it('accepts explicit confirmed:true without a chat phrase', () => {
      expect(
        confirmDestructiveAction({
          fingerprint,
          summary: 'delete company c1',
          confirmed: true,
          principal: 'machine',
        })
      ).toEqual({ ok: true });
    });

    it('refuses without confirmed:true', () => {
      const result = confirmDestructiveAction({ fingerprint, summary: 'delete company c1', principal: 'machine' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('confirmation');
    });

    it('treats an undefined principal as the machine default', () => {
      expect(confirmDestructiveAction({ fingerprint, summary: 'delete company c1', confirmed: true })).toEqual({
        ok: true,
      });
    });
  });
});
