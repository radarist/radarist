/**
 * @file nav-user.test.tsx
 * @description
 * - UX-047 — the account menu item is labeled by where it goes. It said
 *   "Account" but routed to `/settings`, which has no account tab; the label
 *   now matches its destination.
 * - UX-062 — the sidebar binds the visible identity to the canonical owner
 *   profile (not the seeded Firebase Auth `displayName`), and renders neutral
 *   loading / unavailable states during auth-state restoration and sign-out.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('lucide-react', () => {
  const Stub = (props: Record<string, unknown>) => <span {...props} />;
  return new Proxy({}, { get: () => Stub });
});

// Must forward the extra props Radix merges in via `asChild` (role,
// tabindex, handlers) — dropping them would strip the menuitem role the
// accessibility assertions below are about.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mockSignOut = jest.fn();
const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// UX-062: the owner-profile hook is mocked so NavUser's rendering logic is
// isolated from the hook internals (covered in useOwnerProfile.test.ts).
const mockUseOwnerProfile = jest.fn();
jest.mock('@/hooks/useOwnerProfile', () => ({
  useOwnerProfile: () => mockUseOwnerProfile(),
}));

jest.mock('@/components/ui/sidebar', () => ({
  __esModule: true,
  useSidebar: () => ({ isMobile: false }),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children, ...props }: { children: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { NavUser } from '../nav-user';

const FALLBACK_USER = { name: 'Fallback', email: 'fallback@example.com', avatar: '' };

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
});

function defaultAuthed() {
  mockUseAuth.mockReturnValue({
    user: { displayName: 'Claudio', email: 'claudio@example.com', photoURL: '' },
    loading: false,
    signOut: mockSignOut,
  });
  // No owner-profile doc resolved yet — identity falls back to the Auth label,
  // exactly like the brief window before the profile query resolves.
  mockUseOwnerProfile.mockReturnValue({ data: undefined });
}

async function openMenu() {
  const user = userEvent.setup();
  render(<NavUser user={FALLBACK_USER} />);
  await user.click(screen.getByRole('button', { name: /claudio/i }));
  return user;
}

describe('NavUser account menu (UX-047)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    defaultAuthed();
  });

  it('labels the destination "Settings" — both visibly and to assistive tech', async () => {
    await openMenu();
    const item = await screen.findByRole('menuitem', { name: /^settings$/i });
    expect(item).toBeInTheDocument();
  });

  it('preserves the /settings destination', async () => {
    await openMenu();
    const item = await screen.findByRole('menuitem', { name: /^settings$/i });
    expect(item.querySelector('a')?.getAttribute('href') ?? item.getAttribute('href')).toBe('/settings');
  });

  it('no longer offers an "Account" item that names a page the app does not have', async () => {
    await openMenu();
    await screen.findByRole('menuitem', { name: /^settings$/i });
    expect(screen.queryByRole('menuitem', { name: /^account$/i })).toBeNull();
  });

  it('keeps Log out working', async () => {
    const user = await openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /log out/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('NavUser identity binding (UX-062)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    defaultAuthed();
  });

  it('binds the visible name to the owner profile when it exists', () => {
    mockUseOwnerProfile.mockReturnValue({
      data: { uid: 'u1', displayName: 'Real Operator', email: 'real@example.com', photoURL: null },
    });

    render(<NavUser user={FALLBACK_USER} />);

    expect(screen.getByText('Real Operator')).toBeInTheDocument();
  });

  it('the owner profile takes precedence over a polluted Auth displayName', () => {
    // The seed stamps `Radarist Demo User` onto the Firebase Auth displayName.
    // When the owner profile carries the real identity, the real identity wins.
    mockUseAuth.mockReturnValue({
      user: { displayName: 'Radarist Demo User', email: 'demo@radarist.local', photoURL: '' },
      loading: false,
      signOut: mockSignOut,
    });
    mockUseOwnerProfile.mockReturnValue({
      data: { uid: 'u1', displayName: 'Actual Account', email: 'actual@example.com', photoURL: null },
    });

    render(<NavUser user={FALLBACK_USER} />);

    expect(screen.getByText('Actual Account')).toBeInTheDocument();
    expect(screen.queryByText('Radarist Demo User')).toBeNull();
  });

  it('a fresh signup with no profile and no Auth displayName shows the email username, never a demo label', () => {
    mockUseAuth.mockReturnValue({
      user: { displayName: null, email: 'newperson@example.com', photoURL: '' },
      loading: false,
      signOut: mockSignOut,
    });
    // Fresh signup has no owner-profile doc yet.
    mockUseOwnerProfile.mockReturnValue({ data: null });

    render(<NavUser user={FALLBACK_USER} />);

    expect(screen.getByText('newperson')).toBeInTheDocument();
    expect(screen.queryByText('Radarist Demo User')).toBeNull();
    expect(screen.getByText('newperson@example.com')).toBeInTheDocument();
  });

  it('shows the verified Auth email as the ground-truth identity line', () => {
    mockUseAuth.mockReturnValue({
      user: { displayName: 'Some Name', email: 'verified@example.com', photoURL: '' },
      loading: false,
      signOut: mockSignOut,
    });
    mockUseOwnerProfile.mockReturnValue({ data: undefined });

    render(<NavUser user={FALLBACK_USER} />);

    expect(screen.getByText('verified@example.com')).toBeInTheDocument();
  });

  it('renders a neutral loading state (not a stale label) while auth restores', () => {
    // Retained reload: authUser is null and loading is true until
    // onAuthStateChanged resolves. The demo label / fallback must not flash.
    mockUseAuth.mockReturnValue({ user: null, loading: true, signOut: mockSignOut });

    render(<NavUser user={FALLBACK_USER} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Radarist Demo User')).toBeNull();
    expect(screen.queryByText('Fallback')).toBeNull();
  });

  it('falls back to the neutral identity when no account is available (signed out)', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false, signOut: mockSignOut });
    mockUseOwnerProfile.mockReturnValue({ data: undefined });

    render(<NavUser user={FALLBACK_USER} />);

    expect(screen.getByText('Fallback')).toBeInTheDocument();
  });
});
