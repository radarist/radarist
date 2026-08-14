/**
 * UX-056 — bounded classification of an authentication failure.
 *
 * The operator screenshot that opened this row showed the raw provider string
 * `The Firebase ID token has been revoked` rendered as an Assistant chat
 * message. These cases pin the two properties that make that impossible: a
 * failure is reduced to one of a closed set of reasons, and the operator-facing
 * text is ours, never the provider's.
 */
import {
  AUTH_FAILURE_REASONS,
  AUTH_FAILURE_REASON_HEADER,
  authFailureMessage,
  classifyTokenVerificationFailure,
  isStaleSessionCredential,
  parseAuthFailureReason,
} from '@/lib/auth-failure';

/** Shape of a real `FirebaseAuthError`: a prefixed `code` plus prose. */
function authError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('classifyTokenVerificationFailure', () => {
  it('classifies a revoked ID token as a stale session credential', () => {
    const reason = classifyTokenVerificationFailure(
      authError('auth/id-token-revoked', 'The Firebase ID token has been revoked.')
    );

    expect(reason).toBe('token-revoked');
    expect(isStaleSessionCredential(reason)).toBe(true);
  });

  it('classifies an expired ID token as a stale session credential', () => {
    const reason = classifyTokenVerificationFailure(
      authError('auth/id-token-expired', 'The provided Firebase ID token is expired.')
    );

    expect(reason).toBe('token-expired');
    expect(isStaleSessionCredential(reason)).toBe(true);
  });

  it('classifies a disabled or deleted account as unavailable, not stale', () => {
    expect(classifyTokenVerificationFailure(authError('auth/user-disabled', 'The user record is disabled.'))).toBe(
      'account-unavailable'
    );
    expect(classifyTokenVerificationFailure(authError('auth/user-not-found', 'There is no user record.'))).toBe(
      'account-unavailable'
    );
    expect(isStaleSessionCredential('account-unavailable')).toBe(false);
  });

  it('classifies a provider internal error as verification-unavailable, not an invalid token', () => {
    const reason = classifyTokenVerificationFailure(
      authError('auth/internal-error', 'An internal error has occurred.')
    );

    expect(reason).toBe('verification-unavailable');
    expect(isStaleSessionCredential(reason)).toBe(false);
  });

  it('falls back to token-invalid for an uncoded error rather than matching prose', () => {
    // A plain Error carries no `code`. Refusing to pattern-match its prose is
    // what keeps provider text out of the decision AND out of the response.
    expect(classifyTokenVerificationFailure(new Error('Decoding Firebase ID token failed'))).toBe('token-invalid');
    expect(classifyTokenVerificationFailure('unexpected string error')).toBe('token-invalid');
    expect(classifyTokenVerificationFailure(authError('auth/argument-error', 'Invalid argument provided.'))).toBe(
      'token-invalid'
    );
  });
});

describe('authFailureMessage', () => {
  it('never returns provider prose for any reason in the closed set', () => {
    for (const reason of AUTH_FAILURE_REASONS) {
      const message = authFailureMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/firebase/i);
      expect(message).not.toMatch(/token has been revoked/i);
    }
  });

  it('tells a stale-credential operator to sign in again', () => {
    expect(authFailureMessage('token-revoked')).toMatch(/sign in/i);
    expect(authFailureMessage('token-expired')).toMatch(/sign in/i);
  });
});

describe('parseAuthFailureReason', () => {
  it('accepts exactly the closed set and rejects everything else', () => {
    for (const reason of AUTH_FAILURE_REASONS) {
      expect(parseAuthFailureReason(reason)).toBe(reason);
    }
    for (const rejected of ['', 'TOKEN-REVOKED', 'token-revoked ', 'nope', null, undefined, 7, {}]) {
      expect(parseAuthFailureReason(rejected)).toBeNull();
    }
  });
});

describe('AUTH_FAILURE_REASON_HEADER', () => {
  it('is a lowercase header name so client reads are case-stable', () => {
    expect(AUTH_FAILURE_REASON_HEADER).toBe(AUTH_FAILURE_REASON_HEADER.toLowerCase());
  });
});
