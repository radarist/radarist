/**
 * @file AIAssistant.notification-badge.test.tsx
 * @description Tests that the floating-button notification badge respects the
 * persisted "Show notification badge" setting (config.notificationsEnabled).
 *
 * Audit fix: the toggle in Settings → AI Assistant persisted to the store but
 * was never read — the badge rendered unconditionally whenever
 * notificationCount > 0.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

import { DEFAULT_AI_CONFIG } from '@/types/ai-assistant';
import type { AIAssistantConfig } from '@/types/ai-assistant';

// Mock lucide-react with a Proxy so any icon import works
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

// AIChat pulls the full chat stack — irrelevant to badge gating
jest.mock('../AIChat', () => ({
  AIChat: () => <div data-testid="ai-chat" />,
}));

// Brand mark is presentational only
jest.mock('@/components/branding/OctopusLogo', () => ({
  OctopusLogo: () => <svg data-testid="octopus-logo" />,
}));

// Controlled store mock — each test sets the state it needs
interface MockStoreState {
  config: AIAssistantConfig;
  setConfig: jest.Mock;
  isOpen: boolean;
  setIsOpen: jest.Mock;
  toggle: jest.Mock;
  notificationCount: number;
}

const mockStoreState = jest.fn<MockStoreState, []>();
jest.mock('@/stores/ai-store', () => ({
  useAIStore: () => mockStoreState(),
}));

import { AIAssistant } from '../AIAssistant';

function makeStoreState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    config: { ...DEFAULT_AI_CONFIG },
    setConfig: jest.fn(),
    isOpen: false,
    setIsOpen: jest.fn(),
    toggle: jest.fn(),
    notificationCount: 0,
    ...overrides,
  };
}

describe('AIAssistant notification badge gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the badge when notifications are enabled and count > 0', () => {
    mockStoreState.mockReturnValue(
      makeStoreState({
        config: { ...DEFAULT_AI_CONFIG, notificationsEnabled: true },
        notificationCount: 3,
      })
    );

    render(<AIAssistant />);

    const button = screen.getByRole('button', { name: 'Open AI Assistant' });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('hides the badge when notifications are disabled even with count > 0', () => {
    mockStoreState.mockReturnValue(
      makeStoreState({
        config: { ...DEFAULT_AI_CONFIG, notificationsEnabled: false },
        notificationCount: 3,
      })
    );

    render(<AIAssistant />);

    expect(screen.getByRole('button', { name: 'Open AI Assistant' })).toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('shows no badge when count is 0 regardless of the setting', () => {
    mockStoreState.mockReturnValue(
      makeStoreState({
        config: { ...DEFAULT_AI_CONFIG, notificationsEnabled: true },
        notificationCount: 0,
      })
    );

    render(<AIAssistant />);

    expect(screen.getByRole('button', { name: 'Open AI Assistant' })).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('caps the badge at 9+ when enabled with a large count', () => {
    mockStoreState.mockReturnValue(
      makeStoreState({
        config: { ...DEFAULT_AI_CONFIG, notificationsEnabled: true },
        notificationCount: 12,
      })
    );

    render(<AIAssistant />);

    expect(screen.getByText('9+')).toBeInTheDocument();
  });
});

// UX-055 / SETTINGS-004: the floating Assistant must not set a page-wide
// interaction lock. It now renders as a non-modal panel (no overlay), so every
// page control (Settings tabs, triage approve/reject) stays clickable and the
// conversation survives navigation instead of being dismissed on outside click.
describe('AIAssistant floating mode is non-modal (UX-055)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the chat panel without a full-viewport overlay when open', () => {
    mockStoreState.mockReturnValue(
      makeStoreState({
        config: { ...DEFAULT_AI_CONFIG, mode: 'floating' },
        isOpen: true,
      })
    );

    render(<AIAssistant />);

    // The chat mounted (the sheet opened).
    expect(screen.getByTestId('ai-chat')).toBeInTheDocument();
    // Exactly ONE open data-state node == the content only. A modal sheet would
    // add a second overlay node and lock document.body.
    expect(document.body.querySelectorAll('[data-state="open"]').length).toBe(1);
  });

  it('does not lock document.body pointer events while the panel is open', () => {
    mockStoreState.mockReturnValue(
      makeStoreState({
        config: { ...DEFAULT_AI_CONFIG, mode: 'floating' },
        isOpen: true,
      })
    );

    render(<AIAssistant />);

    // A modal Radix Dialog sets pointer-events:none on the body so the page is
    // inert. The non-modal assistant must leave the page interactive.
    expect(document.body.style.pointerEvents).not.toBe('none');
    expect(document.body.getAttribute('data-scroll-locked')).toBeNull();
  });
});
