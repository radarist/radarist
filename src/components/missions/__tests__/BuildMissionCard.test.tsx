/**
 * @file BuildMissionCard.test.tsx
 * @description Render-state + gate-action tests for the build-mission
 * artifact card, plus the pure UI helpers.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MISSION_BUILD_PHASES, missionTitle, pendingGate } from '@/lib/build-mission-ui';
import type { Mission } from '@/lib/schemas/mission';

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

const mockResolveMutate = jest.fn();
const mockCancelMutate = jest.fn();
const mockResumeMutateAsync = jest.fn();
const mockResumeReset = jest.fn();
// BUILD-026 — mutable so a test can drive the cancel-failure error surface.
let mockCancelState: { isPending: boolean; isError: boolean; error: Error | null } = {
  isPending: false,
  isError: false,
  error: null,
};
jest.mock('@/hooks/queries/useBuildMissions', () => ({
  useResolveGate: () => ({ mutate: mockResolveMutate, isPending: false, isError: false, error: null }),
  useCancelBuildMission: () => ({ mutate: mockCancelMutate, ...mockCancelState }),
  useResumeBuildArtifact: () => ({
    mutateAsync: mockResumeMutateAsync,
    reset: mockResumeReset,
    isPending: false,
  }),
}));

const { BuildMissionCard } = require('../BuildMissionCard');

function mission(overrides: Partial<Mission>): Mission {
  return {
    id: 'm1',
    userId: 'u1',
    prompt: '# Mission: Patent Watchlist Manager\n\nbody',
    agent: 'builder',
    kind: 'build',
    status: 'running',
    progress: 50,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-06-11T00:00:00.000Z',
    buildState: 'session-running',
    buildPhase: '06-build',
    budget: { capUsd: 25, warnThreshold: 0.8, topUps: [] },
    ...overrides,
  } as Mission;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelState = { isPending: false, isError: false, error: null };
});

describe('BuildMissionCard render states', () => {
  it('running: title from brief, Building badge, budget meter, cancel visible', () => {
    render(
      <BuildMissionCard
        mission={mission({
          buildCostAccounting: {
            settledActualUsd: 5,
            estimatedUsd: 0,
            activeReservedUsd: 0,
            unsettledMaximumUsd: 0,
            trackedSpendUsd: 5,
            maximumExposureUsd: 5,
            unavailableSessionCount: 0,
            invalidSessionIndexes: [],
            observedAt: '2026-06-11T00:00:00.000Z',
          },
        })}
      />
    );
    expect(screen.getByText('Patent Watchlist Manager')).toBeInTheDocument();
    expect(screen.getByText('Building')).toBeInTheDocument();
    expect(screen.getByTestId('budget-meter')).toHaveTextContent('$5.00 of $25.00');
    expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
    expect(screen.queryByTestId('gate-panel')).not.toBeInTheDocument();
  });

  // ARUN-027: a legacy scalar costUsd must not be presented as precise spend.
  it('shows Unavailable for legacy cost without accounting basis', () => {
    render(<BuildMissionCard mission={mission({ costUsd: 5 })} />);
    expect(screen.getByTestId('budget-meter')).toHaveTextContent('Unavailable of $25.00');
  });

  // BUILD-026 — a cancel the server refused must surface an actionable error,
  // and the button must stay enabled to retry.
  it('running: surfaces the cancel error and keeps the button enabled to retry', () => {
    mockCancelState = {
      isPending: false,
      isError: true,
      error: new Error('Could not stop the build sandbox — the run was not cancelled. Please retry.'),
    };
    render(<BuildMissionCard mission={mission({ costUsd: 5 })} />);
    expect(screen.getByTestId('cancel-error')).toHaveTextContent('the run was not cancelled');
    expect(screen.getByTestId('cancel-button')).not.toBeDisabled();
  });

  it('awaiting-budget: gate panel approves with the entered top-up', () => {
    render(<BuildMissionCard mission={mission({ buildState: 'awaiting-budget', costUsd: 25 })} />);
    expect(screen.getByTestId('gate-panel')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Top-up amount (USD)'), { target: { value: '15' } });
    fireEvent.click(screen.getByText('Approve +$15'));
    expect(mockResolveMutate).toHaveBeenCalledWith({
      missionId: 'm1',
      gate: 'budget',
      decision: 'approve',
      topUpUsd: 15,
    });
  });

  it('awaiting-approval: final gate deny fires without topUp', () => {
    render(<BuildMissionCard mission={mission({ buildState: 'awaiting-approval', buildPhase: '08-qa' })} />);
    fireEvent.click(screen.getByText('Deny'));
    expect(mockResolveMutate).toHaveBeenCalledWith({ missionId: 'm1', gate: 'final', decision: 'deny' });
  });

  it('published: shows run status + QA, links to output, and NO output UI on the card', () => {
    render(
      <BuildMissionCard
        mission={mission({
          status: 'completed',
          buildState: undefined,
          buildPhase: 'published',
          costUsd: 11.43,
          qaGate: {
            attempts: 0,
            verdict: 'PASS',
            findings: [{ severity: 'minor', title: 'favicon 404', detail: '' }],
          },
          artifact: { prototypeId: 'p1', previewUrl: 'http://localhost:4128', publishedAt: 'x' },
        })}
      />
    );
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText(/QA PASS/)).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
    // Output UI moved to the /artifacts catalog — only a link remains here.
    expect(screen.queryByTestId('preview-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('iterate-section')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-output').closest('a')).toHaveAttribute('href', '/artifacts');
  });

  it('evaluation findings live in the catalog, NOT on the run card', () => {
    render(
      <BuildMissionCard
        mission={mission({
          status: 'completed',
          buildState: undefined,
          artifactKind: 'evaluation',
          findings: [{ title: 'Proposed TRL 6 — trial (hands-on)', detail: '', kind: 'verdict', confidence: 82 }],
        })}
      />
    );
    expect(screen.queryByTestId('findings-section')).not.toBeInTheDocument();
    expect(screen.queryByText('Proposed TRL 6 — trial (hands-on)')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-output')).toBeInTheDocument();
  });

  it('failed: destructive badge and first error surfaced', () => {
    render(
      <BuildMissionCard
        mission={mission({ status: 'failed', buildState: 'paused', errors: ['budget gate timed out'] })}
      />
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/budget gate timed out/)).toBeInTheDocument();
  });

  it('mounts failed Limitless recovery on the run card even when no artifact was published', () => {
    render(
      <BuildMissionCard
        mission={mission({
          status: 'failed',
          buildMode: 'limitless',
          buildState: 'paused',
          sandbox: {
            driver: 'docker',
            image: 'builder:test',
            containerName: 'build-m1',
            volumeName: 'radarist_build_m1',
            workspacePath: '/workspace',
            state: 'stopped',
            createdAt: '2026-06-11T00:00:00.000Z',
          },
          errors: ['builder reached max turns'],
        })}
      />
    );

    expect(screen.getByTestId('build-recovery-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume with additional turns' })).toBeInTheDocument();
  });
});

describe('build-mission-ui helpers', () => {
  it('missionTitle prefers the # Mission: heading, falls back to first line, then id', () => {
    expect(missionTitle({ id: 'x', prompt: '# Mission: Radar Viewer\nrest' })).toBe('Radar Viewer');
    expect(missionTitle({ id: 'x', prompt: '## Some heading\nrest' })).toBe('Some heading');
    expect(missionTitle({ id: 'fallback-id', prompt: '' })).toBe('fallback-id');
  });

  it('pendingGate maps awaiting states on running missions only', () => {
    expect(pendingGate({ status: 'running', buildState: 'awaiting-budget' })).toBe('budget');
    expect(pendingGate({ status: 'running', buildState: 'awaiting-stall' })).toBe('stall');
    expect(pendingGate({ status: 'running', buildState: 'awaiting-approval' })).toBe('final');
    expect(pendingGate({ status: 'running', buildState: 'session-running' })).toBeNull();
    expect(pendingGate({ status: 'failed', buildState: 'awaiting-budget' })).toBeNull();
  });

  it('phase ladder matches the schema order with published last', () => {
    expect(MISSION_BUILD_PHASES).toHaveLength(10);
    expect(MISSION_BUILD_PHASES[0]).toBe('00-inception');
    expect(MISSION_BUILD_PHASES[9]).toBe('published');
  });
});
