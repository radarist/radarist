/**
 * Unit tests for useRadarSignalImport.
 *
 * This hook owns the `?importSignal=<id>` → radar-entry flow extracted from
 * app/radar/page.tsx (ARCH-008). The behaviours locked in here are the
 * adversarially-hardened invariants that lived inline before the extraction:
 * first-quadrant default placement, persistence-BEFORE-import-marking ordering,
 * the provenance-failure toast, `?importSignal` query cleanup via the router,
 * and the `handledImportRef` dedup guard against stale-param re-fires.
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import type { QuadrantConfig, RadarEntry, RadarEntrySaveInput, Signal } from '@/lib/types';
import { DEFAULT_COST_TO_PROTOTYPE } from '@/lib/constants';

// ============================================================================
// MOCKS (factories are hoisted — reference module-level jest.fn()s)
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

const mockReplace = jest.fn();
const mockGet = jest.fn<string | null, [string]>();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: mockGet }),
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

const mockGetSignalById = jest.fn();
const mockMarkSignalAsImported = jest.fn();
jest.mock('@/lib/signals-client', () => ({
  getSignalById: (...args: unknown[]) => mockGetSignalById(...args),
  markSignalAsImported: (...args: unknown[]) => mockMarkSignalAsImported(...args),
}));

// Import AFTER mocks
import { useRadarSignalImport } from '../useRadarSignalImport';

// ============================================================================
// FIXTURES
// ============================================================================

const QUADRANTS: QuadrantConfig[] = [
  { id: 'q-first', name: 'Techniques', order: 0 },
  { id: 'q-second', name: 'Tools', order: 1 },
];

// The hook only reads id/title/description/status off a Signal.
function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig1',
    title: 'Edge AI',
    description: 'On-device inference',
    status: 'Approved',
    ...over,
  } as unknown as Signal;
}

function makeSavedEntry(over: Partial<RadarEntry> = {}): RadarEntry {
  return { id: 123, name: 'Edge AI', ...over } as unknown as RadarEntry;
}

const ENTRY_ARG = {
  name: 'Edge AI',
  description: 'On-device inference',
  quadrantId: 'q-first',
  ring: 'Assess',
  tags: [],
  status: 'Stable',
  costToPrototype: DEFAULT_COST_TO_PROTOTYPE,
} as unknown as RadarEntrySaveInput;

interface RenderParams {
  selectedRadarId?: string;
  quadrants?: QuadrantConfig[];
}

function renderImport(params: RenderParams = {}) {
  const saveEntry = jest.fn();
  const setEntryToEdit = jest.fn();
  const openEntrySheet = jest.fn();
  const view = renderHook(() =>
    useRadarSignalImport({
      selectedRadarId: params.selectedRadarId ?? 'radar-1',
      quadrants: params.quadrants ?? QUADRANTS,
      saveEntry,
      setEntryToEdit,
      openEntrySheet,
    })
  );
  return { ...view, saveEntry, setEntryToEdit, openEntrySheet };
}

/** Render with an active import already resolved (importingSignal set). */
async function renderImporting(params: RenderParams = {}) {
  mockGet.mockReturnValue('sig1');
  mockGetSignalById.mockResolvedValue(makeSignal({ id: 'sig1', status: 'Approved' }));
  const view = renderImport(params);
  await waitFor(() => expect(view.result.current.importingSignal).not.toBeNull());
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockReturnValue(null); // default: no ?importSignal
});

// ============================================================================
// IMPORT TRIGGER — first-quadrant placement
// ============================================================================

describe('useRadarSignalImport — import trigger', () => {
  it('opens the entry sheet with the signal defaulted to the FIRST quadrant', async () => {
    mockGet.mockReturnValue('sig1');
    mockGetSignalById.mockResolvedValue(
      makeSignal({ id: 'sig1', title: 'Edge AI', description: 'On-device', status: 'Approved' })
    );

    const { result, setEntryToEdit, openEntrySheet } = renderImport();

    await waitFor(() => expect(result.current.importingSignal).not.toBeNull());

    expect(mockGetSignalById).toHaveBeenCalledWith('sig1');
    expect(setEntryToEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 0,
        name: 'Edge AI',
        description: 'On-device',
        quadrantId: 'q-first',
        ring: 'Assess',
        tags: [],
        status: 'Stable',
        costToPrototype: DEFAULT_COST_TO_PROTOTYPE,
        history: [],
      })
    );
    expect(openEntrySheet).toHaveBeenCalledTimes(1);
    expect(result.current.importingSignal?.id).toBe('sig1');
  });

  it('falls back to an empty quadrantId when the radar has no quadrants', async () => {
    mockGet.mockReturnValue('sig1');
    mockGetSignalById.mockResolvedValue(makeSignal({ status: 'Approved' }));

    const { result, setEntryToEdit } = renderImport({ quadrants: [] });

    await waitFor(() => expect(result.current.importingSignal).not.toBeNull());
    expect(setEntryToEdit).toHaveBeenCalledWith(expect.objectContaining({ quadrantId: '' }));
  });

  it('does NOT open the sheet for an already-Imported signal', async () => {
    mockGet.mockReturnValue('sig1');
    mockGetSignalById.mockResolvedValue(makeSignal({ status: 'Imported' }));

    const { result, setEntryToEdit, openEntrySheet } = renderImport();

    // Give the async getSignalById().then() a tick to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(setEntryToEdit).not.toHaveBeenCalled();
    expect(openEntrySheet).not.toHaveBeenCalled();
    expect(result.current.importingSignal).toBeNull();
  });

  it('does nothing when there is no ?importSignal param', async () => {
    mockGet.mockReturnValue(null);
    const { result, setEntryToEdit, openEntrySheet } = renderImport();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetSignalById).not.toHaveBeenCalled();
    expect(setEntryToEdit).not.toHaveBeenCalled();
    expect(openEntrySheet).not.toHaveBeenCalled();
    expect(result.current.importingSignal).toBeNull();
  });
});

// ============================================================================
// SAVE — persistence before import marking + query cleanup
// ============================================================================

describe('useRadarSignalImport — handleSaveEntry', () => {
  it('saves the entry BEFORE marking the signal imported, then strips ?importSignal', async () => {
    const { result, saveEntry } = await renderImporting();
    saveEntry.mockResolvedValue(makeSavedEntry({ technologyId: 'tech-9' } as Partial<RadarEntry>));
    mockMarkSignalAsImported.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.handleSaveEntry(ENTRY_ARG);
    });

    expect(saveEntry).toHaveBeenCalledTimes(1);
    expect(mockMarkSignalAsImported).toHaveBeenCalledWith('sig1', 'technology', 'tech-9');
    // ordering: the entry write must complete before the provenance write
    expect(saveEntry.mock.invocationCallOrder[0]).toBeLessThan(mockMarkSignalAsImported.mock.invocationCallOrder[0]);
    expect(mockReplace).toHaveBeenCalledWith(window.location.pathname, { scroll: false });
    await waitFor(() => expect(result.current.importingSignal).toBeNull());
  });

  it('surfaces a destructive toast but still RESOLVES when the provenance write fails', async () => {
    const { result, saveEntry } = await renderImporting();
    const saved = makeSavedEntry({ technologyId: 'tech-9' } as Partial<RadarEntry>);
    saveEntry.mockResolvedValue(saved);
    mockMarkSignalAsImported.mockRejectedValue(new Error('provenance boom'));

    let returned: RadarEntry | void = undefined;
    await act(async () => {
      returned = await result.current.handleSaveEntry(ENTRY_ARG);
    });

    expect(returned).toBe(saved); // did NOT reject / lose the save result
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Entry added, signal link failed', variant: 'destructive' })
    );
    expect(mockReplace).toHaveBeenCalledWith(window.location.pathname, { scroll: false });
    await waitFor(() => expect(result.current.importingSignal).toBeNull());
  });

  it('does not mark import when the save returns no technologyId, but still clears state + query', async () => {
    const { result, saveEntry } = await renderImporting();
    saveEntry.mockResolvedValue(makeSavedEntry()); // no technologyId

    await act(async () => {
      await result.current.handleSaveEntry(ENTRY_ARG);
    });

    expect(mockMarkSignalAsImported).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith(window.location.pathname, { scroll: false });
    await waitFor(() => expect(result.current.importingSignal).toBeNull());
  });

  it('is a pure passthrough when no signal import is in progress', async () => {
    mockGet.mockReturnValue(null);
    const { result, saveEntry } = renderImport();
    const saved = makeSavedEntry({ technologyId: 'tech-9' } as Partial<RadarEntry>);
    saveEntry.mockResolvedValue(saved);

    let returned: RadarEntry | void = undefined;
    await act(async () => {
      returned = await result.current.handleSaveEntry(ENTRY_ARG);
    });

    expect(returned).toBe(saved);
    expect(mockMarkSignalAsImported).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

// ============================================================================
// ABANDON + dedup guard
// ============================================================================

describe('useRadarSignalImport — abandon + dedup', () => {
  it('abandonSignalImport clears the pending signal and strips ?importSignal', async () => {
    const { result } = await renderImporting();

    act(() => {
      result.current.abandonSignalImport();
    });

    expect(mockReplace).toHaveBeenCalledWith(window.location.pathname, { scroll: false });
    await waitFor(() => expect(result.current.importingSignal).toBeNull());
  });

  it('does not re-open the sheet after a save consumes the signal (stale-param re-fire)', async () => {
    const { result, saveEntry, setEntryToEdit, openEntrySheet } = await renderImporting();
    saveEntry.mockResolvedValue(makeSavedEntry({ technologyId: 'tech-9' } as Partial<RadarEntry>));
    mockMarkSignalAsImported.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.handleSaveEntry(ENTRY_ARG);
    });
    await waitFor(() => expect(result.current.importingSignal).toBeNull());

    // Simulate the router.replace not yet having flushed to useSearchParams:
    // the param still reads 'sig1' on the next effect pass. The handledImportRef
    // guard must prevent a reopen.
    setEntryToEdit.mockClear();
    openEntrySheet.mockClear();
    mockGetSignalById.mockClear();
    mockGet.mockReturnValue('sig1');

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetSignalById).not.toHaveBeenCalled();
    expect(setEntryToEdit).not.toHaveBeenCalled();
    expect(openEntrySheet).not.toHaveBeenCalled();
  });
});
