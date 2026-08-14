/**
 * @file app/artifacts/[id]/__tests__/page.test.tsx
 * @description BUILD-019 — the Iterate action on a build artifact.
 *
 * The iterate CORE always worked (the API route and the `iterateBuildArtifact`
 * chat tool both call it), but `useIterateBuildMission` had ZERO consumers: the
 * row's acceptance named an artifact-UI action and only the assistant-native
 * half ever shipped. These tests pin the UI half, and — just as importantly —
 * that the server's refusals (a GC-reclaimed sandbox, an exhausted budget) reach
 * the user verbatim instead of failing opaquely.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Mission } from '@/lib/schemas/mission';

let mockMissions: Mission[] = [];
const mockIterate = jest.fn();
let mockIterateState: { isPending: boolean; isError: boolean; isSuccess: boolean; error: Error | null } = {
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null,
};
// BUILD-026 — mutable so a test can drive the Start-failure error surface.
const mockStart = jest.fn();
let mockStartState: { isPending: boolean; isError: boolean; error: Error | null } = {
  isPending: false,
  isError: false,
  error: null,
};
const mockResume = jest.fn();
const mockResumeReset = jest.fn();
let mockResumePending = false;

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'b1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/hooks/queries/useBuildMissions', () => ({
  __esModule: true,
  useBuildMissions: () => ({ data: mockMissions, isLoading: false, error: null }),
  useStartBuildArtifact: () => ({ mutate: mockStart, ...mockStartState }),
  useIterateBuildMission: () => ({ mutate: mockIterate, ...mockIterateState }),
  useResumeBuildArtifact: () => ({
    mutateAsync: mockResume,
    reset: mockResumeReset,
    isPending: mockResumePending,
  }),
}));

jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_t, prop: string) => makeIcon(prop) });
});

import ArtifactDetailPage from '../page';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'b1',
    userId: 'u1',
    agent: 'builder',
    kind: 'build',
    status: 'completed',
    prompt: '# Mission: Widget\n',
    artifactKind: 'solution',
    progress: 100,
    entities: [],
    sources: [],
    slots: [],
    sandbox: { state: 'stopped', hostPort: 5199 },
    createdAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T01:00:00.000Z',
    ...overrides,
  } as unknown as Mission;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIterateState = { isPending: false, isError: false, isSuccess: false, error: null };
  mockStartState = { isPending: false, isError: false, error: null };
  mockResumePending = false;
  mockResume.mockResolvedValue({
    ok: true,
    missionId: 'b1',
    additionalTurns: 40,
    additionalBudgetUsd: 0,
    authorizedMaxTurns: 40,
    capUsd: 50,
  });
  mockMissions = [mission()];
});

describe('artifact Iterate action (BUILD-019)', () => {
  it('dispatches an iteration with the typed instructions', () => {
    render(<ArtifactDetailPage />);

    fireEvent.change(screen.getByPlaceholderText(/dark mode/i), { target: { value: 'add a settings page' } });
    fireEvent.click(screen.getByRole('button', { name: /iterate/i }));

    expect(mockIterate).toHaveBeenCalledWith({ missionId: 'b1', instructions: 'add a settings page' });
  });

  it('refuses to dispatch an empty instruction', () => {
    render(<ArtifactDetailPage />);
    expect(screen.getByRole('button', { name: /iterate/i })).toBeDisabled();
  });

  // AUDIT-017 — the GC reclaimed the workspace, so there is nothing to iterate.
  // Offering a button that can only 410 would be a new lie; hide it.
  it('does not offer Iterate once the sandbox has been reclaimed', () => {
    mockMissions = [mission({ sandbox: { state: 'destroyed' } } as Partial<Mission>)];
    render(<ArtifactDetailPage />);
    expect(screen.queryByRole('button', { name: /iterate/i })).not.toBeInTheDocument();
  });

  it('does not offer Iterate while the build is still running', () => {
    mockMissions = [mission({ status: 'running', completedAt: undefined })];
    render(<ArtifactDetailPage />);
    expect(screen.queryByRole('button', { name: /iterate/i })).not.toBeInTheDocument();
  });

  // The whole point of surfacing the error: a server refusal (reclaimed sandbox,
  // exhausted budget) must reach the user in words, not as a silent no-op.
  it('relays the server refusal verbatim', () => {
    mockIterateState = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: new Error('Mission has spent $150.00 and reached the $150 cumulative build ceiling'),
    };
    render(<ArtifactDetailPage />);
    expect(screen.getByTestId('artifact-iterate-error')).toHaveTextContent(/cumulative build ceiling/i);
  });

  it('confirms a successful dispatch', () => {
    mockIterateState = { isPending: false, isError: false, isSuccess: true, error: null };
    render(<ArtifactDetailPage />);
    expect(screen.getByTestId('artifact-iterate-ok')).toBeInTheDocument();
  });
});

// BUILD-026 — Start now verifies the container + preview before reporting
// success, so a refusal (container didn't come up, preview unreachable) is a
// real failure. It must reach the user, and the button must stay retryable.
describe('artifact Start action (BUILD-026)', () => {
  it('dispatches a start with the mission id', () => {
    render(<ArtifactDetailPage />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(mockStart).toHaveBeenCalledWith('b1');
  });

  it('surfaces the server refusal and keeps the Start button enabled to retry', () => {
    mockStartState = {
      isPending: false,
      isError: true,
      error: new Error('The sandbox restarted but its live preview did not become reachable in time.'),
    };
    render(<ArtifactDetailPage />);
    expect(screen.getByTestId('artifact-start-error')).toHaveTextContent(/preview did not become reachable/i);
    expect(screen.getByRole('button', { name: /start/i })).not.toBeDisabled();
  });

  it('treats a destroyed sandbox as expired without hiding its published prototype', () => {
    mockMissions = [
      mission({
        sandbox: { state: 'destroyed' },
        artifact: {
          prototypeId: 'prototype-1',
          previewUrl: 'http://localhost:5199',
          publishedAt: '2026-07-12T02:00:00.000Z',
        },
      } as Partial<Mission>),
    ];

    render(<ArtifactDetailPage />);

    expect(screen.queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
    expect(screen.getByText(/retained preview workspace is no longer available/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open prototype entity/i })).toBeInTheDocument();
  });

  it('does not offer Start while the preview is already running', () => {
    mockMissions = [mission({ sandbox: { state: 'running', hostPort: 5199 } } as Partial<Mission>)];

    render(<ArtifactDetailPage />);

    expect(screen.queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
  });
});

describe('artifact recovery action (BUILD-038)', () => {
  const recoverable = () =>
    mission({
      status: 'failed',
      buildMode: 'limitless',
      buildPhase: '08-qa',
      artifact: undefined,
      sandbox: {
        driver: 'docker',
        image: 'builder:test',
        containerName: 'build-b1',
        volumeName: 'radarist_build_b1',
        workspacePath: '/workspace',
        state: 'stopped',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
    });

  it('mounts recovery for a failed unpublished Limitless artifact and sends explicit turns-only authority', async () => {
    mockMissions = [recoverable()];
    render(<ArtifactDetailPage />);

    expect(screen.getByTestId('build-recovery-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume with additional turns' }));

    await waitFor(() =>
      expect(mockResume).toHaveBeenCalledWith({
        missionId: 'b1',
        additionalTurns: 40,
        additionalBudgetUsd: 0,
      })
    );
  });

  it('does not offer recovery for a standard-tier build', () => {
    mockMissions = [mission({ status: 'failed' })];
    render(<ArtifactDetailPage />);
    expect(screen.queryByTestId('build-recovery-panel')).not.toBeInTheDocument();
  });

  it('shows a reclaimed workspace honestly but provides no recovery action', () => {
    mockMissions = [mission({ ...recoverable(), sandbox: { ...recoverable().sandbox!, state: 'destroyed' } })];
    render(<ArtifactDetailPage />);

    expect(screen.getByTestId('recovery-unavailable')).toHaveTextContent(/reclaimed/i);
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();
  });

  it('does not offer recovery while the build is running', () => {
    mockMissions = [mission({ ...recoverable(), status: 'running', completedAt: undefined })];
    render(<ArtifactDetailPage />);
    expect(screen.queryByTestId('build-recovery-panel')).not.toBeInTheDocument();
  });

  it('does not offer recovery once the build published', () => {
    mockMissions = [
      mission({
        ...recoverable(),
        status: 'completed',
        buildPhase: 'published',
        artifact: { prototypeId: 'p1', publishedAt: '2026-07-12T02:00:00.000Z' },
      }),
    ];
    render(<ArtifactDetailPage />);
    expect(screen.queryByTestId('build-recovery-panel')).not.toBeInTheDocument();
  });

  it('shows a pending state while the recovery request is in flight', () => {
    mockMissions = [recoverable()];
    mockResumePending = true;
    render(<ArtifactDetailPage />);
    expect(screen.getByRole('button', { name: /resuming/i })).toBeDisabled();
  });

  it('relays the server refusal verbatim', async () => {
    mockMissions = [recoverable()];
    mockResume.mockRejectedValueOnce(new Error('The sandbox was reclaimed after its retention window.'));
    render(<ArtifactDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume with additional turns' }));
    expect(await screen.findByTestId('recovery-error')).toHaveTextContent(/reclaimed after its retention window/i);
  });
});
