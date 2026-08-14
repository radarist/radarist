import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Mission } from '@/lib/schemas/mission';

jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => (
          <svg data-testid={'icon-' + prop} {...props} />
        );
        Icon.displayName = prop;
        return Icon;
      },
    }
  );
});

const mockMutateAsync = jest.fn();
const mockReset = jest.fn();
let mockPending = false;
jest.mock('@/hooks/queries/useBuildMissions', () => ({
  useResumeBuildArtifact: () => ({
    mutateAsync: mockMutateAsync,
    reset: mockReset,
    isPending: mockPending,
  }),
}));

import { BuildRecoveryPanel } from '@/components/missions/BuildRecoveryPanel';

function failedLimitlessMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-limitless-1',
    userId: 'user-1',
    prompt: '# Mission: Quantum workbench',
    agent: 'builder',
    kind: 'build',
    buildMode: 'limitless',
    status: 'failed',
    progress: 72,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-07-18T10:00:00.000Z',
    completedAt: '2026-07-18T11:00:00.000Z',
    buildPhase: '08-qa',
    sandbox: {
      driver: 'docker',
      image: 'radarist-builder:test',
      containerName: 'radarist-build-mission-limitless-1',
      volumeName: 'radarist_build_mission-limitless-1',
      workspacePath: '/workspace',
      state: 'stopped',
      createdAt: '2026-07-18T10:00:00.000Z',
    },
    budget: { capUsd: 50, warnThreshold: 0.8, topUps: [] },
    recovery: {
      terminal: {
        reason: 'turns-exhausted',
        recordedAt: '2026-07-18T11:00:00.000Z',
        phase: '08-qa',
        turnsUsed: 80,
        maxTurns: 80,
      },
      attempts: [],
    },
    buildCostAccounting: {
      settledActualUsd: 31.25,
      estimatedUsd: 4.5,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 7,
      maximumExposureUsd: 42.75,
      trackedSpendUsd: 35.75,
      unavailableSessionCount: 1,
      invalidSessionIndexes: [],
      observedAt: '2026-07-18T11:00:00.000Z',
    },
    ...overrides,
  } as Mission;
}

describe('BuildRecoveryPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPending = false;
    mockMutateAsync.mockResolvedValue({
      ok: true,
      missionId: 'mission-limitless-1',
      additionalTurns: 40,
      additionalBudgetUsd: 0,
      authorizedMaxTurns: 40,
      capUsd: 50,
    });
  });

  it('shows terminal cause, retained phase, turn bound, exposure buckets, volume, and fresh-review requirement', () => {
    render(<BuildRecoveryPanel mission={failedLimitlessMission()} />);

    expect(screen.getByText('Builder turn limit reached')).toBeInTheDocument();
    expect(screen.getByText('08-qa')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-volume-state')).toHaveTextContent(
      'Retained · radarist_build_mission-limitless-1'
    );
    expect(screen.getByText('$31.25')).toBeInTheDocument();
    expect(screen.getByText('$4.50')).toBeInTheDocument();
    expect(screen.getByText('$7.00')).toBeInTheDocument();
    expect(screen.getByText('$42.75')).toBeInTheDocument();
    expect(screen.getByText(/fresh independent reviewer must run and pass/i)).toBeInTheDocument();
  });

  it('dispatches the default 40-turn recovery immediately when no spend is requested', async () => {
    render(<BuildRecoveryPanel mission={failedLimitlessMission()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume with additional turns' }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        missionId: 'mission-limitless-1',
        additionalTurns: 40,
        additionalBudgetUsd: 0,
      })
    );
    expect(screen.queryByText(/explicit spend authorization required/i)).not.toBeInTheDocument();
    expect(await screen.findByTestId('recovery-success')).toHaveTextContent('40-turn builder bound');
  });

  it('requires the exact server phrase on a separate paid submission', async () => {
    const phrase = 'CONFIRM SPEND $12.00 resume-fingerprint';
    mockMutateAsync
      .mockResolvedValueOnce({
        requiresConfirmation: true,
        confirmationPhrase: phrase,
        amountUsd: 12,
        message: 'Nothing was dispatched.',
      })
      .mockResolvedValueOnce({
        ok: true,
        missionId: 'mission-limitless-1',
        additionalTurns: 60,
        additionalBudgetUsd: 12,
        authorizedMaxTurns: 60,
        capUsd: 62,
      });
    render(<BuildRecoveryPanel mission={failedLimitlessMission()} />);

    fireEvent.change(screen.getByLabelText('Additional builder turns'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Optional budget top-up (USD)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request spend confirmation' }));

    expect(await screen.findByTestId('recovery-confirmation-phrase')).toHaveTextContent(phrase);
    const confirmButton = screen.getByRole('button', { name: 'Confirm and resume' });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Spend confirmation phrase'), { target: { value: phrase + ' ' } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Spend confirmation phrase'), { target: { value: phrase } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockMutateAsync).toHaveBeenLastCalledWith({
      missionId: 'mission-limitless-1',
      additionalTurns: 60,
      additionalBudgetUsd: 12,
      confirmationText: phrase,
    });
  });

  it('invalidates a staged phrase when the bound turn or budget request changes', async () => {
    mockMutateAsync.mockResolvedValueOnce({
      requiresConfirmation: true,
      confirmationPhrase: 'CONFIRM SPEND $5.00 old-fingerprint',
      amountUsd: 5,
    });
    render(<BuildRecoveryPanel mission={failedLimitlessMission()} />);

    fireEvent.change(screen.getByLabelText('Optional budget top-up (USD)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request spend confirmation' }));
    expect(await screen.findByTestId('recovery-confirmation-phrase')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Additional builder turns'), { target: { value: '41' } });
    expect(screen.queryByTestId('recovery-confirmation-phrase')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request spend confirmation' })).toBeEnabled();
  });

  it('rejects turn values outside the explicit 1 to 160 range without a request', async () => {
    render(<BuildRecoveryPanel mission={failedLimitlessMission()} />);

    fireEvent.change(screen.getByLabelText('Additional builder turns'), { target: { value: '161' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume with additional turns' }));

    expect(await screen.findByTestId('recovery-error')).toHaveTextContent('whole number from 1 to 160');
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('surfaces a server refusal without claiming recovery started', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('The retained volume no longer exists'));
    render(<BuildRecoveryPanel mission={failedLimitlessMission()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume with additional turns' }));

    expect(await screen.findByTestId('recovery-error')).toHaveTextContent('retained volume no longer exists');
    expect(screen.queryByTestId('recovery-success')).not.toBeInTheDocument();
  });

  it('shows reclaimed failed Limitless workspaces as unavailable without an action', () => {
    render(
      <BuildRecoveryPanel
        mission={failedLimitlessMission({
          sandbox: {
            ...failedLimitlessMission().sandbox!,
            state: 'destroyed',
          },
        })}
      />
    );

    expect(screen.getByTestId('recovery-volume-state')).toHaveTextContent('Reclaimed');
    expect(screen.getByTestId('recovery-unavailable')).toHaveTextContent(/start a new build instead/i);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    ['standard build', { buildMode: 'standard' as const }],
    ['running build', { status: 'running' as const }],
    ['completed build', { status: 'completed' as const }],
    [
      'published build',
      {
        buildPhase: 'published' as const,
        artifact: { prototypeId: 'prototype-1', publishedAt: '2026-07-18T12:00:00.000Z' },
      },
    ],
  ])('does not render recovery for a %s', (_label, overrides) => {
    const { container } = render(<BuildRecoveryPanel mission={failedLimitlessMission(overrides)} />);
    expect(container).toBeEmptyDOMElement();
  });
});
