/**
 * @file NewArtifactDialog.test.tsx
 * @description BUILD-027 — the dispatch dialog must show the build-disabled
 * state BEFORE dispatch (a banner + a disabled Dispatch button) instead of
 * letting the user write a brief and only learn on submit that builds are off.
 * When builds are enabled it behaves normally.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const mockDispatch = jest.fn();
jest.mock('@/hooks/queries/useBuildMissions', () => ({
  useDispatchArtifact: () => ({ mutate: mockDispatch, isPending: false }),
}));

// BUILD-027 — mutable capability probe result.
let mockCapabilityData: { buildEnabled: boolean } | undefined = { buildEnabled: true };
jest.mock('@/hooks/queries/useBuildCapability', () => ({
  useBuildCapability: () => ({ data: mockCapabilityData }),
}));

import { NewArtifactDialog } from '../NewArtifactDialog';

async function openDialog() {
  const user = userEvent.setup();
  render(<NewArtifactDialog />);
  await user.click(screen.getByTestId('new-artifact-button'));
  return user;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCapabilityData = { buildEnabled: true };
});

describe('NewArtifactDialog build availability (BUILD-027)', () => {
  it('shows the disabled banner and disables Dispatch when builds are off', async () => {
    mockCapabilityData = { buildEnabled: false };
    await openDialog();

    expect(screen.getByTestId('build-disabled-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dispatch build/i })).toBeDisabled();
  });

  it('does not block dispatch when builds are enabled', async () => {
    mockCapabilityData = { buildEnabled: true };
    await openDialog();

    expect(screen.queryByTestId('build-disabled-banner')).not.toBeInTheDocument();
    // The default brief template is long enough to satisfy the min-length gate.
    expect(screen.getByRole('button', { name: /dispatch build/i })).not.toBeDisabled();
  });

  it('does not block dispatch while the capability probe is still unknown', async () => {
    // Loading / failed probe → `data` is undefined; the server still enforces
    // the gate, so the button must not be a dead end.
    mockCapabilityData = undefined;
    await openDialog();

    expect(screen.queryByTestId('build-disabled-banner')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dispatch build/i })).not.toBeDisabled();
  });

  it('dispatches when Dispatch is clicked and builds are enabled', async () => {
    const user = await openDialog();
    await user.click(screen.getByRole('button', { name: /dispatch build/i }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});
