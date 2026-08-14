/**
 * @file login/__tests__/session-ended-notice.test.tsx
 * @description UX-056 — the login screen explains why the session ended.
 *
 * The operator's original experience was a raw provider string in a chat
 * message. The replacement has to be more than a silent bounce to a sign-in
 * form: the reason arrives as a bounded query value and the screen renders OUR
 * copy for it — never the parameter, and never provider prose.
 */

import { render, screen } from '@testing-library/react';

// Same shape the other page-level suites use: lucide ships ESM that Jest's
// transform does not process, and the icons are irrelevant to this contract.
jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg aria-hidden="true" {...props} />;
          Icon.displayName = prop;
          return Icon;
        },
      }
    )
);

let mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => '/login',
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    signIn: jest.fn(),
    signInWithGoogle: jest.fn(),
    loading: false,
  }),
}));

import { AUTH_SESSION_EXPIRED_QUERY } from '@/lib/auth-failure';
import LoginPage from '../page';

function renderWith(query: string | null): void {
  mockSearchParams = new URLSearchParams(query ? `${AUTH_SESSION_EXPIRED_QUERY}=${query}` : '');
  render(<LoginPage />);
}

describe('login session-ended notice (UX-056)', () => {
  it('explains a revoked session and tells the operator what to do', () => {
    renderWith('token-revoked');

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/no longer valid/i);
    expect(notice).toHaveTextContent(/sign in again/i);
  });

  it('distinguishes an expired session from a revoked one', () => {
    renderWith('token-expired');

    expect(screen.getByRole('status')).toHaveTextContent(/expired/i);
  });

  it('never renders provider text or the raw parameter', () => {
    renderWith('token-revoked');

    const notice = screen.getByRole('status');
    expect(notice.textContent ?? '').not.toMatch(/firebase/i);
    expect(notice.textContent ?? '').not.toMatch(/token-revoked/);
  });

  it('shows nothing for an unrecognised parameter value', () => {
    // A hand-edited or stale URL must not be able to put arbitrary text on the
    // sign-in screen.
    renderWith('<script>alert(1)</script>');

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing on an ordinary visit', () => {
    renderWith(null);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
