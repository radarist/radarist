/**
 * @file McpApiKeysPanel.test.tsx
 * @description Smoke tests for the restored MCP API Keys settings panel.
 *
 * Tests cover:
 * - Keys returned by /api/mcp/keys render with name, prefix, and permission badges
 * - Empty state when the user has no keys
 * - Error toast when key listing fails
 * - Create-dialog client validation fires before any POST is sent
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// ============================================================================
// Mocks
// ============================================================================

// JSDOM doesn't implement ResizeObserver — Radix primitives use it via
// @radix-ui/react-use-size. Same stub pattern as AgentConfigEditor.test.tsx.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

// lucide-react ships as ESM which Jest doesn't transform by default.
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { McpApiKeysPanel } from '../McpApiKeysPanel';

// ============================================================================
// Test utilities
// ============================================================================

function jsonResponse(body: unknown, ok = true, status = 200): Pick<Response, 'ok' | 'status' | 'json'> {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

const SAMPLE_KEY = {
  id: 'key-1',
  name: 'Claude Desktop',
  prefix: 'tp_live_abc1****',
  permissions: ['read', 'write'],
  createdAt: 1735689600000, // 2025-01-01
  lastUsedAt: undefined,
  expiresAt: null,
};

// ============================================================================
// Tests
// ============================================================================

describe('McpApiKeysPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-1' }, loading: false });
  });

  it('renders keys returned by /api/mcp/keys with name, prefix, and permission badges', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, data: [SAMPLE_KEY] }));

    render(<McpApiKeysPanel />);

    expect(await screen.findByText('Claude Desktop')).toBeInTheDocument();
    expect(screen.getByText('tp_live_abc1****')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('write')).toBeInTheDocument();
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/mcp/keys');
  });

  it('shows the empty state when the user has no keys', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, data: [] }));

    render(<McpApiKeysPanel />);

    expect(await screen.findByText('No API keys created yet')).toBeInTheDocument();
  });

  it('surfaces an error toast when key listing fails', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: false, error: 'boom' }, false, 500));

    render(<McpApiKeysPanel />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Failed to load API keys',
        expect.objectContaining({ description: 'boom' })
      );
    });
  });

  it('does not fetch keys when no user is signed in', async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });

    render(<McpApiKeysPanel />);

    expect(await screen.findByText('No API keys created yet')).toBeInTheDocument();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('validates the key name client-side before POSTing', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, data: [] }));
    const user = userEvent.setup();

    render(<McpApiKeysPanel />);
    await screen.findByText('No API keys created yet');

    // Open the create dialog
    await user.click(screen.getByRole('button', { name: /create key/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Submit with an empty name (scope to the dialog — the trigger button
    // outside the portal shares the same accessible name)
    await user.click(within(dialog).getByRole('button', { name: /^create key$/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Name required', expect.anything());
    });
    // Only the initial GET — no POST was issued
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
