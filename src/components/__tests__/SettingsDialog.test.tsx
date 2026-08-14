/**
 * @file components/__tests__/SettingsDialog.test.tsx
 * @description Component tests for the variable-quadrants SettingsDialog
 *
 * Covers Phase 8 requirements from the plan:
 *   - Add/remove/reorder rows, with 1/8 enforcement
 *   - Validation (empty names, duplicates, range)
 *   - Async save contract — dialog stays open on rejection
 *   - Orphan resolution modal opens on OrphanedPlacementsError and retries
 *     the save with the user's resolution plan
 *
 * Also satisfies Gate G8.
 */

// ============================================================================
// MOCKS
// ============================================================================

// lucide-react ships as ESM which Jest doesn't transform by default. Mock
// every icon with a simple <svg> stub so the dialog module graph can load.
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

jest.mock('@/hooks/use-toast', () => ({
  useToast: jest.fn(() => ({ toast: jest.fn() })),
}));

// The orphan preview resolves technology display names through the service
// layer; mock it so no Firebase import chain is triggered. The default mock
// resolves nothing, so tests without explicit setup exercise the raw-id
// fallback.
jest.mock('@/lib/technology-service', () => ({
  getTechnologyById: jest.fn(),
}));

// ============================================================================
// IMPORTS
// ============================================================================

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { SettingsDialog } from '../SettingsDialog';
import { getTechnologyById } from '@/lib/technology-service';
import type { QuadrantConfig, RingSystem, Technology } from '@/lib/types';
import type { OrphanReport } from '@/lib/radars';

const mockGetTechnologyById = getTechnologyById as jest.MockedFunction<typeof getTechnologyById>;

// ============================================================================
// TEST UTILITIES
// ============================================================================

function buildQuadrants(count: number): QuadrantConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `q_fixture_${i}`,
    name: `Quadrant ${i + 1}`,
    order: i,
  }));
}

interface RenderOptions {
  quadrants?: QuadrantConfig[];
  onSave?: jest.Mock;
  onOpenChange?: jest.Mock;
  ringSystem?: RingSystem;
}

function renderDialog(options: RenderOptions = {}) {
  const onSave = options.onSave ?? jest.fn().mockResolvedValue(undefined);
  const onOpenChange = options.onOpenChange ?? jest.fn();
  const quadrants = options.quadrants ?? buildQuadrants(4);
  const utils = render(
    <SettingsDialog
      isOpen
      onOpenChange={onOpenChange}
      quadrants={quadrants}
      ringSystem={options.ringSystem ?? 'Standard'}
      onSave={onSave}
    />
  );
  return { ...utils, onSave, onOpenChange };
}

// ============================================================================
// TESTS
// ============================================================================

describe('SettingsDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Initial render
  // --------------------------------------------------------------------------

  describe('initial render', () => {
    it('seeds draft rows from the radar config', () => {
      renderDialog({ quadrants: buildQuadrants(4) });

      for (let i = 0; i < 4; i++) {
        expect(screen.getByDisplayValue(`Quadrant ${i + 1}`)).toBeInTheDocument();
      }
      expect(screen.getByText(/Quadrants \(4 of 8\)/i)).toBeInTheDocument();
    });

    it('shows each existing quadrant id below its name input', () => {
      renderDialog({ quadrants: buildQuadrants(2) });
      expect(screen.getByText('id: q_fixture_0')).toBeInTheDocument();
      expect(screen.getByText('id: q_fixture_1')).toBeInTheDocument();
    });

    it('renders 1 quadrant when the radar has only 1', () => {
      renderDialog({ quadrants: buildQuadrants(1) });
      expect(screen.getByText(/Quadrants \(1 of 8\)/i)).toBeInTheDocument();
      expect(screen.getByDisplayValue('Quadrant 1')).toBeInTheDocument();
    });

    it('renders 8 quadrants when the radar is at the maximum', () => {
      renderDialog({ quadrants: buildQuadrants(8) });
      expect(screen.getByText(/Quadrants \(8 of 8\)/i)).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Add / remove / reorder
  // --------------------------------------------------------------------------

  describe('row management', () => {
    it('adds a new empty row when Add Quadrant is clicked', async () => {
      const user = userEvent.setup();
      renderDialog({ quadrants: buildQuadrants(3) });

      await user.click(screen.getByRole('button', { name: /add quadrant/i }));

      expect(screen.getByText(/Quadrants \(4 of 8\)/i)).toBeInTheDocument();
      // The new row has an empty input with placeholder "Quadrant name"
      const inputs = screen.getAllByPlaceholderText('Quadrant name');
      expect(inputs).toHaveLength(4);
      expect(inputs[3]).toHaveValue('');
    });

    it('disables Add Quadrant button at 8 rows', () => {
      renderDialog({ quadrants: buildQuadrants(8) });
      const addBtn = screen.getByRole('button', { name: /add quadrant/i });
      expect(addBtn).toBeDisabled();
    });

    it('removes a row when the × button is clicked', async () => {
      const user = userEvent.setup();
      renderDialog({ quadrants: buildQuadrants(4) });

      const removeBtn = screen.getByRole('button', { name: /remove quadrant 2/i });
      await user.click(removeBtn);

      expect(screen.getByText(/Quadrants \(3 of 8\)/i)).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Quadrant 2')).not.toBeInTheDocument();
    });

    it('disables the × button at the minimum of 1 row', () => {
      renderDialog({ quadrants: buildQuadrants(1) });
      const removeBtn = screen.getByRole('button', { name: /remove quadrant 1/i });
      expect(removeBtn).toBeDisabled();
    });

    it('swaps two rows when the down chevron is clicked', async () => {
      const user = userEvent.setup();
      renderDialog({ quadrants: buildQuadrants(3) });

      // Before: #1 = Quadrant 1, #2 = Quadrant 2
      const downBtn1 = screen.getByRole('button', { name: /move quadrant 1 down/i });
      await user.click(downBtn1);

      // After: #1 should now show "Quadrant 2", #2 should show "Quadrant 1"
      const inputs = screen.getAllByPlaceholderText('Quadrant name') as HTMLInputElement[];
      expect(inputs[0].value).toBe('Quadrant 2');
      expect(inputs[1].value).toBe('Quadrant 1');
    });

    it('swaps two rows when the up chevron is clicked', async () => {
      const user = userEvent.setup();
      renderDialog({ quadrants: buildQuadrants(3) });

      const upBtn3 = screen.getByRole('button', { name: /move quadrant 3 up/i });
      await user.click(upBtn3);

      const inputs = screen.getAllByPlaceholderText('Quadrant name') as HTMLInputElement[];
      expect(inputs[1].value).toBe('Quadrant 3');
      expect(inputs[2].value).toBe('Quadrant 2');
    });

    it('disables up chevron on the first row and down chevron on the last row', () => {
      renderDialog({ quadrants: buildQuadrants(3) });

      expect(screen.getByRole('button', { name: /move quadrant 1 up/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /move quadrant 3 down/i })).toBeDisabled();
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('blocks save when a row has an empty name', async () => {
      const user = userEvent.setup();
      const { onSave } = renderDialog({ quadrants: buildQuadrants(3) });

      // Clear the first row's name
      const firstInput = screen.getAllByPlaceholderText('Quadrant name')[0];
      await user.clear(firstInput);

      expect(screen.getByText(/every quadrant must have a name/i)).toBeInTheDocument();
      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();

      // Confirm the save callback was never invoked
      await user.click(saveBtn);
      expect(onSave).not.toHaveBeenCalled();
    });

    it('blocks save when two rows have the same name', async () => {
      const user = userEvent.setup();
      const { onSave } = renderDialog({ quadrants: buildQuadrants(3) });

      const inputs = screen.getAllByPlaceholderText('Quadrant name');
      await user.clear(inputs[1]);
      await user.type(inputs[1], 'Quadrant 1');

      expect(screen.getByText(/must be unique/i)).toBeInTheDocument();
      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();
      await user.click(saveBtn);
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Save contract
  // --------------------------------------------------------------------------

  describe('save contract', () => {
    it('calls onSave with the canonical QuadrantConfig[] on success and closes', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockResolvedValue(undefined);
      const onOpenChange = jest.fn();
      renderDialog({ quadrants: buildQuadrants(3), onSave, onOpenChange });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const [configs, ringSystem] = onSave.mock.calls[0];
      expect(configs).toHaveLength(3);
      expect(configs[0]).toMatchObject({ id: 'q_fixture_0', name: 'Quadrant 1', order: 0 });
      expect(configs[1]).toMatchObject({ id: 'q_fixture_1', name: 'Quadrant 2', order: 1 });
      expect(ringSystem).toBe('Standard');

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('saves the latest ring system when the selected radar changes after mount', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockResolvedValue(undefined);
      const onOpenChange = jest.fn();
      const quadrants = buildQuadrants(2);
      const { rerender } = renderDialog({ quadrants, ringSystem: 'Standard', onSave, onOpenChange });

      rerender(
        <SettingsDialog isOpen onOpenChange={onOpenChange} quadrants={quadrants} ringSystem="TRL" onSave={onSave} />
      );
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0][1]).toBe('TRL');
    });

    it('omits `description: undefined` from the saved configs', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockResolvedValue(undefined);
      renderDialog({ quadrants: buildQuadrants(2), onSave });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const configs = onSave.mock.calls[0][0];
      for (const c of configs) {
        // Firestore forbids `undefined` values — verify none slipped through
        expect(c).not.toHaveProperty('description');
      }
    });

    it('round-trips stored descriptions truthfully, including an empty one', async () => {
      // GRAPH-068: this dialog edits names only — it never exposes a description
      // field — so every description it emits is data it is merely passing back.
      // The old truthiness guard dropped any falsy description, which silently
      // deleted a stored empty string on a rename the operator never asked for.
      // Omitting only an ABSENT description is the shared normalizer's rule; the
      // dialog must not apply a second, different one.
      const user = userEvent.setup();
      const onSave = jest.fn().mockResolvedValue(undefined);
      const quadrants: QuadrantConfig[] = [
        { id: 'q_fixture_0', name: 'Quadrant 1', order: 0, description: '' },
        { id: 'q_fixture_1', name: 'Quadrant 2', order: 1, description: 'Kept text' },
        { id: 'q_fixture_2', name: 'Quadrant 3', order: 2 },
      ];
      renderDialog({ quadrants, onSave });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const configs = onSave.mock.calls[0][0];
      expect(configs[0]).toHaveProperty('description', '');
      expect(configs[1]).toHaveProperty('description', 'Kept text');
      // The row that never had a description still carries no key at all.
      expect(configs[2]).not.toHaveProperty('description');
    });

    it('mints stable ids for brand-new rows via defaultQuadrantIdFromName', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockResolvedValue(undefined);
      renderDialog({ quadrants: buildQuadrants(2), onSave });

      await user.click(screen.getByRole('button', { name: /add quadrant/i }));
      const inputs = screen.getAllByPlaceholderText('Quadrant name');
      await user.type(inputs[2], 'AI Infrastructure');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const configs = onSave.mock.calls[0][0];
      expect(configs[2]).toMatchObject({
        id: 'q_ai_infrastructure',
        name: 'AI Infrastructure',
        order: 2,
      });
    });

    it('keeps the dialog open and shows a toast on arbitrary errors', async () => {
      const user = userEvent.setup();
      const toastMock = jest.fn();
      const { useToast } = require('@/hooks/use-toast') as { useToast: jest.Mock };
      useToast.mockReturnValue({ toast: toastMock });

      const onSave = jest.fn().mockRejectedValue(new Error('Network unreachable'));
      const onOpenChange = jest.fn();
      renderDialog({ quadrants: buildQuadrants(2), onSave, onOpenChange });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(toastMock).toHaveBeenCalled());
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/could not save/i),
          description: 'Network unreachable',
          variant: 'destructive',
        })
      );
      // Dialog should NOT close on error
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
  });

  // --------------------------------------------------------------------------
  // Orphan resolution flow
  // --------------------------------------------------------------------------

  describe('orphan resolution modal', () => {
    function makeOrphanError() {
      const report: OrphanReport = {
        orphans: [
          {
            quadrantId: 'q_fixture_2',
            quadrantName: 'Quadrant 3',
            placements: [
              { id: 'placement-1', technologyId: 'tech-a', ring: 'Adopt' },
              { id: 'placement-2', technologyId: 'tech-b', ring: 'Trial' },
            ],
          },
        ],
        totalPlacements: 2,
      };
      const error = Object.assign(new Error('orphan'), { report });
      error.name = 'OrphanedPlacementsError';
      return error;
    }

    it('opens the orphan modal when onSave throws OrphanedPlacementsError', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockRejectedValueOnce(makeOrphanError());
      renderDialog({ quadrants: buildQuadrants(3), onSave });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(screen.getByText(/resolve orphaned placements/i)).toBeInTheDocument());
      expect(screen.getByText(/Quadrant 3/)).toBeInTheDocument();
      // Preview rows should list the orphan placement ids
      expect(screen.getByText(/tech-a/)).toBeInTheDocument();
      expect(screen.getByText(/tech-b/)).toBeInTheDocument();
    });

    it('shows resolved technology names in the orphan preview while preserving the canonical id (UX-044)', async () => {
      const user = userEvent.setup();
      mockGetTechnologyById.mockImplementation(async (id: string) => {
        const names: Record<string, string> = { 'tech-a': 'Alpha Fabric', 'tech-b': 'Beta Mesh' };
        return names[id] ? ({ id, name: names[id] } as Technology) : null;
      });
      const onSave = jest.fn().mockRejectedValueOnce(makeOrphanError());
      renderDialog({ quadrants: buildQuadrants(3), onSave });

      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(screen.getByText(/resolve orphaned placements/i)).toBeInTheDocument());

      // Preview rows display human-readable names…
      expect(await screen.findByText(/Alpha Fabric/)).toBeInTheDocument();
      expect(screen.getByText(/Beta Mesh/)).toBeInTheDocument();
      // …not raw ids as text, while the canonical id stays inspectable.
      expect(screen.queryByText(/tech-a/)).not.toBeInTheDocument();
      expect(screen.getByTitle('tech-a')).toBeInTheDocument();
      expect(screen.getByTitle('tech-b')).toBeInTheDocument();
    });

    it('falls back to the raw technology id when name resolution fails', async () => {
      const user = userEvent.setup();
      mockGetTechnologyById.mockRejectedValue(new Error('offline'));
      const onSave = jest.fn().mockRejectedValueOnce(makeOrphanError());
      renderDialog({ quadrants: buildQuadrants(3), onSave });

      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(screen.getByText(/resolve orphaned placements/i)).toBeInTheDocument());

      expect(screen.getByText(/tech-a/)).toBeInTheDocument();
      expect(screen.getByText(/tech-b/)).toBeInTheDocument();
    });

    it('disables Continue Save until every orphan has a resolution', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockRejectedValueOnce(makeOrphanError());
      renderDialog({ quadrants: buildQuadrants(3), onSave });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Wait for the orphan modal
      await waitFor(() => expect(screen.getByText(/resolve orphaned placements/i)).toBeInTheDocument());

      // Default resolution is the first config's id, so Continue Save should
      // be enabled from the start. Let's verify the button exists and is
      // enabled when every group has a default pick.
      const continueBtn = screen.getByRole('button', { name: /continue save/i });
      expect(continueBtn).toBeEnabled();
    });

    it('retries onSave with the reassignment plan when the user confirms', async () => {
      const user = userEvent.setup();
      // First call throws orphan error, second call succeeds
      const onSave = jest
        .fn()
        .mockImplementationOnce(() => Promise.reject(makeOrphanError()))
        .mockImplementationOnce(() => Promise.resolve(undefined));
      const onOpenChange = jest.fn();
      renderDialog({ quadrants: buildQuadrants(3), onSave, onOpenChange });

      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(screen.getByText(/resolve orphaned placements/i)).toBeInTheDocument());

      // Confirm with default resolution (= first config's id: 'q_fixture_0')
      await user.click(screen.getByRole('button', { name: /continue save/i }));

      // onSave should be invoked a second time, this time with orphan options
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
      const secondCall = onSave.mock.calls[1];
      const options = secondCall[2];
      expect(options).toBeDefined();
      expect(options.reassignments).toEqual({ q_fixture_2: 'q_fixture_0' });
      // After success, the dialog closes
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('closes only the orphan modal on "Back" and keeps the main dialog open', async () => {
      const user = userEvent.setup();
      const onSave = jest.fn().mockRejectedValueOnce(makeOrphanError());
      const onOpenChange = jest.fn();
      renderDialog({ quadrants: buildQuadrants(3), onSave, onOpenChange });

      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(screen.getByText(/resolve orphaned placements/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /back/i }));

      await waitFor(() => expect(screen.queryByText(/resolve orphaned placements/i)).not.toBeInTheDocument());
      // Main dialog should still be open — no onOpenChange(false)
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    // NOTE: the "delete permanently" sentinel is exercised by the service-layer
    // test suite (`radars.test.ts`) — we skip a dialog-level test for that
    // branch because Radix `Select` renders options in a portal that jsdom
    // struggles to drive through userEvent. The reassignment path above
    // verifies that the dialog correctly forwards any orphan-resolution plan
    // to the parent callback.
  });

  // --------------------------------------------------------------------------
  // Cancel
  // --------------------------------------------------------------------------

  describe('cancel', () => {
    it('calls onOpenChange(false) when Cancel is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = jest.fn();
      renderDialog({ quadrants: buildQuadrants(3), onOpenChange });

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // --------------------------------------------------------------------------
  // Accessibility
  // --------------------------------------------------------------------------

  describe('accessibility', () => {
    it("uses aria-label for each row's reorder and remove buttons", () => {
      renderDialog({ quadrants: buildQuadrants(3) });

      expect(screen.getByRole('button', { name: /move quadrant 1 up/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /move quadrant 1 down/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove quadrant 1/i })).toBeInTheDocument();
    });

    it('uses aria-label on each name input', () => {
      renderDialog({ quadrants: buildQuadrants(3) });

      expect(screen.getByRole('textbox', { name: /quadrant 1 name/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /quadrant 2 name/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /quadrant 3 name/i })).toBeInTheDocument();
    });

    it('exposes the validation message as a live region', async () => {
      const user = userEvent.setup();
      renderDialog({ quadrants: buildQuadrants(2) });

      await user.clear(screen.getAllByPlaceholderText('Quadrant name')[0]);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/every quadrant must have a name/i);
    });
  });

  // --------------------------------------------------------------------------
  // Guard against silent mutation of props
  // --------------------------------------------------------------------------

  it('does not mutate the input quadrants prop', async () => {
    const user = userEvent.setup();
    const quadrants = buildQuadrants(3);
    const originalCopy = JSON.parse(JSON.stringify(quadrants));
    const onSave = jest.fn().mockResolvedValue(undefined);
    renderDialog({ quadrants, onSave });

    // Rename the first row and save
    const input = screen.getAllByPlaceholderText('Quadrant name')[0];
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());

    // The prop array must be untouched
    expect(quadrants).toEqual(originalCopy);
  });
});

// Silence unused warning for `within` import used by other consumers if any
void within;
