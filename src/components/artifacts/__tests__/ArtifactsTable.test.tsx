/**
 * @file ArtifactsTable.test.tsx
 * @description P-F3: pins the /artifacts full-row click → `/artifacts/[id]`
 * navigation affordance (cursor-pointer + hover:bg-accent/30, matching the
 * library tables), and that the row's interactive cells (checkbox, ⋯ menu,
 * source-run pill) stop propagation so they don't also trigger a navigation.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

const startMutate = jest.fn();
const stopMutate = jest.fn();
jest.mock('@/hooks/queries/useBuildMissions', () => ({
  useStartBuildArtifact: () => ({ mutate: startMutate, isPending: false }),
  useStopBuildArtifact: () => ({ mutate: stopMutate, isPending: false }),
}));

// BUILD-026 — Start/Stop surface their outcome via toast (no inline room in a
// dropdown). Mock sonner so a test can assert the failure toast fires.
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => mockToastSuccess(...a), error: (...a: unknown[]) => mockToastError(...a) },
}));

import { ArtifactsTable } from '../ArtifactsTable';
import type { Mission } from '@/lib/schemas/mission';

beforeAll(() => {
  // Radix UI primitives touch these APIs which jsdom does not implement.
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
});

function makeMission(overrides: Partial<Mission> & { id: string }): Mission {
  return {
    userId: 'u1',
    prompt: '# Mission: Competitive teardown of Foo',
    agent: 'creator',
    kind: 'build',
    artifactKind: 'report',
    status: 'completed',
    progress: 100,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-06-01T09:00:00.000Z',
    completedAt: '2026-06-01T09:05:00.000Z',
    artifact: { documentId: 'doc-1', publishedAt: '2026-06-01T09:05:00.000Z' },
    ...overrides,
  } as Mission;
}

function renderTable(rows: Mission[]) {
  render(
    <ArtifactsTable
      rows={rows}
      sortConfig={null}
      onSort={jest.fn()}
      isSelected={() => false}
      onToggleSelection={jest.fn()}
      isAllSelected={false}
      isSomeSelected={false}
      onSelectAllChange={jest.fn()}
      onDelete={jest.fn()}
    />
  );
}

describe('ArtifactsTable — row click navigation (P-F3)', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
  });

  it('navigates to the artifact detail route when the row is clicked', () => {
    const mission = makeMission({ id: 'artifact-nav' });
    renderTable([mission]);

    fireEvent.click(screen.getByText('Competitive teardown of Foo'));

    expect(mockRouterPush).toHaveBeenCalledWith('/artifacts/artifact-nav');
  });

  it('does not navigate when the row actions (⋯) menu is clicked', () => {
    const mission = makeMission({ id: 'artifact-menu' });
    renderTable([mission]);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not navigate when the row checkbox is clicked', () => {
    const mission = makeMission({ id: 'artifact-checkbox' });
    renderTable([mission]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Competitive teardown of Foo' }));

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not navigate to the artifact when the source-run pill is clicked', () => {
    const mission = makeMission({ id: 'artifact-run' });
    renderTable([mission]);

    fireEvent.click(screen.getByText('Completed'));

    expect(mockRouterPush).not.toHaveBeenCalledWith('/artifacts/artifact-run');
    expect(mockRouterPush).toHaveBeenCalledWith('/agents/runs?tab=builds&build=artifact-run');
  });
});

// BUILD-026 — app-artifact Start/Stop must report their real outcome. The
// menu items pass onSuccess/onError callbacks that toast; a failed sandbox
// operation is never swallowed silently.
describe('ArtifactsTable — app lifecycle outcome toasts (BUILD-026)', () => {
  beforeEach(() => {
    startMutate.mockReset();
    stopMutate.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
  });

  function appRow() {
    return makeMission({
      id: 'app-1',
      artifactKind: 'solution',
      artifact: { prototypeId: 'proto-1', publishedAt: '2026-06-01T09:05:00.000Z' },
    });
  }

  it('toasts an error when Start fails, and a success when it succeeds', async () => {
    const user = userEvent.setup();
    renderTable([appRow()]);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    await user.click(screen.getByRole('menuitem', { name: /start/i }));

    expect(startMutate).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ onError: expect.any(Function), onSuccess: expect.any(Function) })
    );
    const opts = startMutate.mock.calls[0][1] as { onError: (e: Error) => void; onSuccess: () => void };
    opts.onError(new Error('The sandbox did not come back up. Please retry.'));
    expect(mockToastError).toHaveBeenCalledWith('The sandbox did not come back up. Please retry.');
    opts.onSuccess();
    expect(mockToastSuccess).toHaveBeenCalledWith('Preview started');
  });

  it('toasts an error when Stop fails', async () => {
    const user = userEvent.setup();
    renderTable([appRow()]);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    await user.click(screen.getByRole('menuitem', { name: /stop/i }));

    expect(stopMutate).toHaveBeenCalledWith('app-1', expect.objectContaining({ onError: expect.any(Function) }));
    const opts = stopMutate.mock.calls[0][1] as { onError: (e: Error) => void };
    opts.onError(new Error('The sandbox did not stop. Please retry.'));
    expect(mockToastError).toHaveBeenCalledWith('The sandbox did not stop. Please retry.');
  });
});
