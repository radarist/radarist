/**
 * @file AIAssistantPanel.test.tsx
 * @description AI-005 — the settings panel renders the "Learned Mission
 * Preferences" card: loading → empty state for fresh users, harvested values +
 * pin state + Reset for harvested users, and the honest "mission dispatch
 * only" caption in both cases.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

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

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockSetConfig = jest.fn();
jest.mock('@/stores/ai-store', () => ({
  useAIStore: () => ({
    config: { mode: 'floating', panelWidth: 400, notificationsEnabled: true },
    setConfig: mockSetConfig,
  }),
}));

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { AIAssistantPanel } from '../AIAssistantPanel';

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

const HARVESTED = {
  preferences: {
    userId: 'u1',
    updatedAt: '2026-07-01T00:00:00.000Z',
    missionsAnalyzed: 12,
    preferredStructure: 'SBAR',
    structureConfidence: 0.7,
    preferredCitationStyle: 'IEEE',
    requestsConfidenceScores: true,
    preferredAgents: [{ agent: 'creator', count: 8 }],
    topTopics: ['Agentic Memory', 'Vector Databases'],
    avgPromptLength: 300,
    pinned: { preferredStructure: 'SBAR' },
  },
  topicWeights: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchWithAuth.mockResolvedValue(jsonResponse(HARVESTED));
});

describe('AIAssistantPanel — Learned Mission Preferences card (AI-005)', () => {
  it('renders the card with the mission-only caption and the harvested values', async () => {
    render(<AIAssistantPanel />);

    expect(await screen.findByText('Learned Mission Preferences')).toBeInTheDocument();
    expect(screen.getByText(/mission dispatch only — chat does not read these/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Report structure')).toBeInTheDocument());
    expect(screen.getByText('Citation style')).toBeInTheDocument();
    expect(screen.getByText('Confidence scores')).toBeInTheDocument();
    expect(screen.getByText('Recent focus areas')).toBeInTheDocument();
    expect(screen.getByText('Agentic Memory')).toBeInTheDocument();
    expect(screen.getByText(/creator \(8\)/)).toBeInTheDocument();
    expect(screen.getByText(/Analyzed 12 missions/)).toBeInTheDocument();
    // The pinned structure shows its badge and the Reset entry point exists.
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/user/preferences');
  });

  it('shows the empty state (and no Reset) for a fresh user', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ preferences: null, topicWeights: null }));
    render(<AIAssistantPanel />);

    expect(await screen.findByText(/No learned preferences yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    // Caption stays visible so the scope is honest even before the first harvest.
    expect(screen.getByText(/mission dispatch only — chat does not read these/i)).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails (no crash)', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500));
    render(<AIAssistantPanel />);
    expect(await screen.findByText(/Could not load learned preferences/i)).toBeInTheDocument();
  });

  it('still renders the existing display-mode settings sections', async () => {
    render(<AIAssistantPanel />);
    expect(screen.getByText('Display Mode')).toBeInTheDocument();
    expect(screen.getByText('Keyboard Shortcut')).toBeInTheDocument();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
  });

  it('gives every radio and switch an explicit accessible name', async () => {
    render(<AIAssistantPanel />);

    expect(screen.getByRole('radio', { name: 'Floating button' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Persistent panel' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show notification badge' })).toBeInTheDocument();

    await screen.findByText('Report structure');
    expect(screen.getByRole('switch', { name: 'Pin report structure preference' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pin citation style preference' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pin confidence scores preference' })).toBeInTheDocument();
  });
});
