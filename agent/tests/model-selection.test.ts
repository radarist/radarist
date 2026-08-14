import {
  detectModelSubstitution,
  MODEL_FALLBACK_AUTHORIZATION_ENV,
  parseModelAuthorizationEntries,
  resolveFallbackModelSelection,
  resolveSdkModel,
  resolveTransparentRetryFallback,
  UnsupportedModelError,
} from '../src/model-selection';

describe('model selection truth', () => {
  it('passes exact priced ids and explicit aliases through unchanged', () => {
    expect(resolveSdkModel('claude-opus-5')).toEqual({ ok: true, model: 'claude-opus-5', kind: 'exact' });
    expect(resolveSdkModel('claude-opus-4-8')).toEqual({ ok: true, model: 'claude-opus-4-8', kind: 'exact' });
    expect(resolveSdkModel('opus')).toEqual({ ok: true, model: 'opus', kind: 'alias' });
  });

  it('refuses unknown model ids before spend', () => {
    expect(resolveSdkModel('claude-opus-9-9')).toEqual({ ok: false, reason: 'unsupported-model' });
    const error = new UnsupportedModelError([
      { scope: 'agent:creator', requested: 'claude-opus-9-9', reason: 'unsupported-model' },
    ]);
    expect(error.failureKind).toBe('unsupported-model');
    expect(error.message).toContain('agent:creator');
  });

  it('records Opus 5 to 4.8 as unauthorized without the exact authorization', () => {
    expect(detectModelSubstitution({ requested: 'claude-opus-5', primaryServed: 'claude-opus-4-8', env: {} })).toEqual({
      requested: 'claude-opus-5',
      served: 'claude-opus-4-8',
      servedModels: ['claude-opus-4-8'],
      authorized: false,
    });
  });

  it('authorizes only the configured fallback or an exact requested-to-served pair', () => {
    const env = { [MODEL_FALLBACK_AUTHORIZATION_ENV]: 'claude-opus-5>claude-opus-4-8' };
    expect(
      detectModelSubstitution({ requested: 'claude-opus-5', primaryServed: 'claude-opus-4-8', env })
    ).toMatchObject({ authorized: true, authorizedBy: 'explicit-pair' });
    expect(
      detectModelSubstitution({ requested: 'claude-opus-5', primaryServed: 'claude-haiku-4-5', env })
    ).toMatchObject({ authorized: false });
    expect(
      detectModelSubstitution({
        requested: 'claude-opus-5',
        primaryServed: 'claude-haiku-4-5',
        configuredFallback: 'claude-haiku-4-5',
        env: {},
      })
    ).toMatchObject({ authorized: true, authorizedBy: 'configured-fallback' });
  });

  it('rejects malformed authorization entries instead of partially accepting them', () => {
    expect(parseModelAuthorizationEntries('a>b>c, claude-opus-5>claude-opus-4-8')).toEqual({
      valid: [{ requested: 'claude-opus-5', served: 'claude-opus-4-8' }],
      invalid: [{ index: 0 }],
    });
  });

  it('does not confuse an auxiliary model with the primary served model', () => {
    expect(
      detectModelSubstitution({
        requested: 'claude-opus-4-8',
        primaryServed: 'claude-opus-4-8',
        servedModels: ['claude-opus-4-8', 'claude-haiku-4-5'],
      })
    ).toBeUndefined();
  });
});

describe('fallback model selection (COORD-012 envelope authority)', () => {
  it('uses exactly the envelope-authorized fallback when one is present', () => {
    expect(
      resolveFallbackModelSelection({
        authorizedFallbackModel: 'claude-sonnet-5',
        envFallback: 'claude-haiku-4-5',
        defaultFallback: 'claude-haiku-4-5',
      })
    ).toBe('claude-sonnet-5');
  });

  it('disables the SDK fallback entirely when the envelope authorized none', () => {
    expect(
      resolveFallbackModelSelection({
        authorizedFallbackModel: null,
        envFallback: 'claude-haiku-4-5',
        defaultFallback: 'claude-haiku-4-5',
      })
    ).toBeUndefined();
  });

  it('keeps the legacy environment-then-default chain when no envelope authority exists', () => {
    expect(resolveFallbackModelSelection({ envFallback: 'claude-sonnet-5', defaultFallback: 'claude-haiku-4-5' })).toBe(
      'claude-sonnet-5'
    );
    expect(resolveFallbackModelSelection({ defaultFallback: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
  });

  it('treats a blank envelope authorization as disabled rather than falling back to env', () => {
    expect(
      resolveFallbackModelSelection({
        authorizedFallbackModel: '  ',
        envFallback: 'claude-haiku-4-5',
        defaultFallback: 'claude-haiku-4-5',
      })
    ).toBeUndefined();
  });
});

describe('COORD-019 transparent-retry fallback pair resolution', () => {
  it('drops a fallback that names the very model it would retry', () => {
    // The reproduced case: a revision turn whose role profile pins the same id
    // the worker environment configured as the fallback. The SDK refuses this
    // pair before spawning the CLI child, so the run dies with no provider call.
    expect(resolveTransparentRetryFallback('claude-opus-4-8', 'claude-opus-4-8')).toBeUndefined();
  });

  it('treats a dated snapshot of the same model as the same model, in both directions', () => {
    // Broader than the SDK's exact `===` on purpose — retrying a snapshot of the
    // model that just failed buys nothing.
    expect(resolveTransparentRetryFallback('claude-opus-4-8', 'claude-opus-4-8-20260101')).toBeUndefined();
    expect(resolveTransparentRetryFallback('claude-opus-4-8-20260101', 'claude-opus-4-8')).toBeUndefined();
  });

  it('leaves a genuinely different fallback untouched', () => {
    expect(resolveTransparentRetryFallback('claude-opus-4-8', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(resolveTransparentRetryFallback('claude-opus-5', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('stays disabled when no fallback was configured at all', () => {
    expect(resolveTransparentRetryFallback('claude-opus-4-8', undefined)).toBeUndefined();
  });

  it('does not confuse two distinct models that share a prefix', () => {
    // `claude-opus-4-8` vs `claude-opus-4-8-turbo` — the suffix is not a dated
    // snapshot, so these stay distinct and the fallback survives.
    expect(resolveTransparentRetryFallback('claude-opus-4-8', 'claude-opus-4-8-turbo')).toBe('claude-opus-4-8-turbo');
  });
});
