/**
 * @file login/__tests__/page.test.tsx
 * @description Pins the login page's "Local demo mode" credentials hint:
 * hidden unless NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true', and when
 * visible it shows the seeded demo credentials, fills the form via the
 * "Fill demo credentials" button, and can be dismissed for the session.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// AuthProvider — mock useAuth so the test never reaches firebase/auth or
// @/lib/firebase through the provider's static import chain.
// ---------------------------------------------------------------------------
const signInMock = jest.fn().mockResolvedValue(undefined);
const signInWithGoogleMock = jest.fn().mockResolvedValue(undefined);

jest.mock('@/components/providers/AuthProvider', () => ({
  __esModule: true,
  useAuth: () => ({
    user: null,
    loading: false,
    signIn: signInMock,
    signUp: jest.fn(),
    signInWithGoogle: signInWithGoogleMock,
    signOut: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// lucide-react ESM proxy stub — Jest's CJS transform can't load lucide
// directly. Render every icon as a tagged span.
// ---------------------------------------------------------------------------
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => makeIcon(prop),
    }
  );
});

import LoginPage from '../page';
import { DEMO_USER_EMAIL as DEMO_EMAIL, DEMO_USER_PASSWORD as DEMO_PASSWORD } from '@/lib/demo-credentials';

const EMULATOR_ENV_KEY = 'NEXT_PUBLIC_USE_FIREBASE_EMULATOR';

describe('LoginPage demo credentials hint', () => {
  const originalEmulatorEnv = process.env[EMULATOR_ENV_KEY];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[EMULATOR_ENV_KEY];
  });

  afterAll(() => {
    if (originalEmulatorEnv === undefined) {
      delete process.env[EMULATOR_ENV_KEY];
    } else {
      process.env[EMULATOR_ENV_KEY] = originalEmulatorEnv;
    }
  });

  it('hides the hint when NEXT_PUBLIC_USE_FIREBASE_EMULATOR is unset', () => {
    render(<LoginPage />);

    expect(screen.queryByText('Local demo mode')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fill demo credentials/i })).not.toBeInTheDocument();
  });

  it('hides the hint when NEXT_PUBLIC_USE_FIREBASE_EMULATOR is not exactly "true"', () => {
    process.env[EMULATOR_ENV_KEY] = 'false';
    render(<LoginPage />);

    expect(screen.queryByText('Local demo mode')).not.toBeInTheDocument();
  });

  it('shows the hint with the demo credentials when the emulator flag is set', () => {
    process.env[EMULATOR_ENV_KEY] = 'true';
    render(<LoginPage />);

    expect(screen.getByText('Local demo mode')).toBeInTheDocument();
    expect(screen.getByText(DEMO_EMAIL)).toBeInTheDocument();
    expect(screen.getByText(DEMO_PASSWORD)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fill demo credentials/i })).toBeInTheDocument();
  });

  it('fills the email and password fields when "Fill demo credentials" is clicked', async () => {
    process.env[EMULATOR_ENV_KEY] = 'true';
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /fill demo credentials/i }));

    expect(screen.getByLabelText('Email')).toHaveValue(DEMO_EMAIL);
    expect(screen.getByLabelText('Password')).toHaveValue(DEMO_PASSWORD);
  });

  it('submits the demo credentials through the existing sign-in flow after filling', async () => {
    process.env[EMULATOR_ENV_KEY] = 'true';
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /fill demo credentials/i }));
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(signInMock).toHaveBeenCalledWith(DEMO_EMAIL, DEMO_PASSWORD);
  });

  it('dismisses the hint when the close button is clicked', async () => {
    process.env[EMULATOR_ENV_KEY] = 'true';
    const user = userEvent.setup();
    render(<LoginPage />);

    expect(screen.getByText('Local demo mode')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss demo credentials hint/i }));

    expect(screen.queryByText('Local demo mode')).not.toBeInTheDocument();
    // The rest of the login form stays mounted.
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});
