/**
 * @file useCompaniesPage.test.tsx
 * @description Pins the companies-page hook behavior added for the table's
 * Research column + Location sort:
 *
 *   1. compareCompanies('location'): locale-aware (localeCompare) ordering of
 *      the rendered "City, Country" label; missing locations always last in
 *      BOTH directions; equal labels compare 0 (stable sort keeps order).
 *   2. getCompanyLocationLabel renders "City, Country" with missing parts
 *      dropped.
 *   3. toggleSort('location') re-sorts filteredCompanies through the same
 *      mechanism as the other sortable columns.
 *   4. handleResearchFromMenu tracks the in-flight company id in
 *      researchingCompanyIds (added on start, removed on success AND failure)
 *      and persists the research via updateCompany.
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import type { Company, CompanyNote, CompanyResearch } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';

let mockSelectedCompany: Company | undefined;
const mockToast = jest.fn();

// ============================================================================
// MOCKS — factories are hoisted, so jest.fn() inline; grab references after.
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

jest.mock('@/lib/companies', () => ({
  getCompanies: jest.fn(),
  getCompanyById: jest.fn(),
  deleteCompany: jest.fn(),
  createCompany: jest.fn(),
  updateCompany: jest.fn(),
}));

jest.mock('@/lib/company-notes', () => ({
  getNotesByCompanyId: jest.fn().mockResolvedValue([]),
  createNote: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

jest.mock('@/lib/relations', () => ({
  getRelationsForEntity: jest.fn().mockResolvedValue([]),
  getRelationsForEntities: jest.fn().mockResolvedValue({}),
  createRelation: jest.fn(),
  deleteRelation: jest.fn(),
}));

jest.mock('@/lib/technology-service', () => ({ getTechnologyById: jest.fn() }));
jest.mock('@/lib/use-cases', () => ({ getUseCaseById: jest.fn() }));
jest.mock('@/lib/prototypes', () => ({ getPrototypeById: jest.fn() }));
jest.mock('@/lib/strategies', () => ({ getStrategyById: jest.fn() }));
jest.mock('@/lib/signals-client', () => ({ getSignalById: jest.fn() }));
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/hooks/useSheetUrl', () => ({
  useControlledSheet: () => ({
    selectedEntity: mockSelectedCompany,
    isOpen: !!mockSelectedCompany,
    open: jest.fn(),
    close: jest.fn(),
    onOpenChange: jest.fn(),
  }),
}));

jest.mock('@/hooks/useDataRefresh', () => ({ useDataRefresh: jest.fn() }));

jest.mock('@/lib/entity-graph-sync-outbox-client', () => ({
  listEntityGraphSyncAnchors: jest.fn().mockResolvedValue([]),
  recordEntityGraphSyncAnchor: jest.fn().mockResolvedValue(null),
  readEntityGraphSyncAnchor: jest.fn().mockResolvedValue({ generation: 'a'.repeat(32) }),
  advanceEntityGraphSyncAnchor: jest.fn().mockResolvedValue(null),
  markEntityGraphSyncAnchorDispatched: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/ai/flows/research-company-comprehensive', () => ({
  researchCompanyComprehensive: jest.fn(),
}));

// Import AFTER mocks
import {
  useCompaniesPage,
  buildComprehensiveResearchInput,
  compareCompanies,
  getCompanyLocationLabel,
  applyResearchToUpdate,
} from '../useCompaniesPage';
import { getCompanies, getCompanyById, deleteCompany, createCompany, updateCompany } from '@/lib/companies';
import { getNotesByCompanyId, updateNote } from '@/lib/company-notes';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { researchCompanyComprehensive } from '@/ai/flows/research-company-comprehensive';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import { listEntityGraphSyncAnchors } from '@/lib/entity-graph-sync-outbox-client';

const mockedGetCompanies = getCompanies as jest.MockedFunction<typeof getCompanies>;
const mockedDeleteCompany = deleteCompany as jest.MockedFunction<typeof deleteCompany>;
const mockedCreateCompany = createCompany as jest.MockedFunction<typeof createCompany>;
const mockedGetCompanyById = getCompanyById as jest.MockedFunction<typeof getCompanyById>;
const mockedUpdateCompany = updateCompany as jest.MockedFunction<typeof updateCompany>;
const mockedGetNotesByCompanyId = getNotesByCompanyId as jest.MockedFunction<typeof getNotesByCompanyId>;
const mockedUpdateNote = updateNote as jest.MockedFunction<typeof updateNote>;
const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;
const mockedResearch = researchCompanyComprehensive as jest.MockedFunction<typeof researchCompanyComprehensive>;

// ============================================================================
// TEST DATA
// ============================================================================

function makeCompany(overrides: Partial<Company> & { id: string; name: string }): Company {
  return {
    slug: overrides.id,
    description: '',
    website: '',
    type: ['startup'],
    industry: [],
    size: 'small',
    stage: 'seed',
    location: { city: '', country: '' },
    status: 'Watching',
    tags: [],
    socialLinks: { linkedin: '', twitter: '', github: '' },
    technologyStack: [],
    documents: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Company;
}

describe('useCompaniesPage — graph recovery scope', () => {
  it('loads only Company recovery anchors', async () => {
    const listAnchors = jest.mocked(listEntityGraphSyncAnchors);
    listAnchors.mockClear();

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(listAnchors).toHaveBeenCalledWith('company'));
  });
});

// Note: 'austin' (lowercase) before 'Boston' pins locale-aware comparison —
// a naive codepoint sort would put 'Boston' (B=66) before 'austin' (a=97).
const ACME = makeCompany({ id: 'c1', name: 'Acme', location: { city: 'austin', country: 'USA' } });
const BRAVO = makeCompany({ id: 'c2', name: 'Bravo', location: { city: 'Boston', country: 'USA' } });
const CHARLIE = makeCompany({ id: 'c3', name: 'Charlie', location: { city: '', country: '' } }); // missing
const DELTA = makeCompany({ id: 'c4', name: 'Delta', location: { city: '', country: 'Germany' } });

const ALL = [ACME, BRAVO, CHARLIE, DELTA];

const MINIMAL_RESEARCH: CompanyResearch = { lastResearched: 1, version: 1 };

const ORIGINAL_NOTE: CompanyNote = {
  id: 'note-1',
  companyId: ACME.id,
  content: 'Original note',
  type: 'General',
  createdAt: 1,
};

const EDITED_NOTE: CompanyNote = {
  ...ORIGINAL_NOTE,
  content: 'Edited note',
};

const ASC: SortConfig = { key: 'location', direction: 'asc' };
const DESC: SortConfig = { key: 'location', direction: 'desc' };

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectedCompany = undefined;
  mockedGetCompanies.mockResolvedValue(ALL);
  mockedGetCompanyById.mockResolvedValue(null);
  mockedCreateCompany.mockResolvedValue(ACME);
  mockedUpdateCompany.mockResolvedValue(undefined);
  mockedGetNotesByCompanyId.mockResolvedValue([]);
  mockedUpdateNote.mockResolvedValue({ updatedAt: Date.now() });
  mockedFetchWithAuth.mockResolvedValue({
    ok: true,
    status: 202,
    json: async () => ({ success: true }),
  } as Response);
});

// ============================================================================
// PURE HELPERS
// ============================================================================

describe('getCompanyLocationLabel', () => {
  it('renders "City, Country"', () => {
    expect(getCompanyLocationLabel(ACME)).toBe('austin, USA');
  });

  it('drops missing parts', () => {
    expect(getCompanyLocationLabel(DELTA)).toBe('Germany');
    expect(getCompanyLocationLabel(CHARLIE)).toBe('');
    expect(getCompanyLocationLabel({ location: undefined as unknown as Company['location'] })).toBe('');
  });
});

describe('compareCompanies — location', () => {
  it('sorts ascending, locale-aware, missing last', () => {
    const sorted = [...ALL].sort((a, b) => compareCompanies(a, b, ASC));
    expect(sorted.map((c) => c.id)).toEqual(['c1', 'c2', 'c4', 'c3']);
  });

  it('sorts descending with missing locations still last', () => {
    const sorted = [...ALL].sort((a, b) => compareCompanies(a, b, DESC));
    expect(sorted.map((c) => c.id)).toEqual(['c4', 'c2', 'c1', 'c3']);
  });

  it('returns 0 for equal labels so the stable sort preserves order', () => {
    const twin = makeCompany({ id: 'c5', name: 'Twin', location: { city: 'austin', country: 'USA' } });
    expect(compareCompanies(ACME, twin, ASC)).toBe(0);
    expect(compareCompanies(CHARLIE, makeCompany({ id: 'c6', name: 'Empty' }), ASC)).toBe(0);
  });

  it('keeps existing name sort intact', () => {
    const sorted = [...ALL].reverse().sort((a, b) => compareCompanies(a, b, { key: 'name', direction: 'asc' }));
    expect(sorted.map((c) => c.name)).toEqual(['Acme', 'Bravo', 'Charlie', 'Delta']);
  });
});

// ============================================================================
// HOOK — location sort wiring
// ============================================================================

describe('useCompaniesPage — location sort', () => {
  it('toggleSort("location") re-sorts filteredCompanies asc, then desc; missing always last', async () => {
    const { result } = renderHook(() => useCompaniesPage());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.filteredCompanies).toHaveLength(4);

    act(() => result.current.toggleSort('location'));
    await waitFor(() => expect(result.current.filteredCompanies.map((c) => c.id)).toEqual(['c1', 'c2', 'c4', 'c3']));
    expect(result.current.sortState).toEqual({ key: 'location', direction: 'asc' });

    act(() => result.current.toggleSort('location'));
    await waitFor(() => expect(result.current.filteredCompanies.map((c) => c.id)).toEqual(['c4', 'c2', 'c1', 'c3']));
    expect(result.current.sortState).toEqual({ key: 'location', direction: 'desc' });
  });
});

// ============================================================================
// HOOK — research-in-flight tracking
// ============================================================================

describe('useCompaniesPage — handleResearchFromMenu', () => {
  it('tracks the company id while research is in flight and persists on success', async () => {
    let resolveResearch!: (value: CompanyResearch) => void;
    mockedResearch.mockReturnValue(
      new Promise<CompanyResearch>((resolve) => {
        resolveResearch = resolve;
      })
    );
    mockedGetCompanyById.mockResolvedValue({ ...ACME, research: MINIMAL_RESEARCH });

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let researchPromise!: Promise<void>;
    act(() => {
      researchPromise = result.current.handleResearchFromMenu(ACME);
    });

    // In flight: id is tracked (drives the "Researching..." badge).
    expect(result.current.researchingCompanyIds.has('c1')).toBe(true);

    await act(async () => {
      resolveResearch(MINIMAL_RESEARCH);
      await researchPromise;
    });

    expect(result.current.researchingCompanyIds.has('c1')).toBe(false);
    expect(mockedUpdateCompany).toHaveBeenCalledWith('c1', expect.objectContaining({ research: MINIMAL_RESEARCH }));
    // Local data refreshed with the researched company.
    expect(result.current.companies.find((c) => c.id === 'c1')?.research).toEqual(MINIMAL_RESEARCH);
  });

  it('clears the in-flight id when research fails', async () => {
    mockedResearch.mockRejectedValue(new Error('research blew up'));

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.handleResearchFromMenu(ACME);
    });

    expect(result.current.researchingCompanyIds.has('c1')).toBe(false);
    expect(mockedUpdateCompany).not.toHaveBeenCalled();
  });

  it('reports committed research as saved locally when only graph handoff fails', async () => {
    const committed = { ...ACME, research: MINIMAL_RESEARCH };
    mockedResearch.mockResolvedValue(MINIMAL_RESEARCH);
    mockedUpdateCompany.mockRejectedValueOnce(
      new EntitySyncDispatchError('company', ACME.id, 'update', new Error('queue unavailable'))
    );
    mockedGetCompanyById.mockResolvedValueOnce(committed);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.handleResearchFromMenu(ACME);
    });

    expect(result.current.companies.find(({ id }) => id === ACME.id)?.research).toEqual(MINIMAL_RESEARCH);
    expect(result.current.graphSyncRecoveries[0]?.entityId).toBe(ACME.id);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved locally' }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Research Failed' }));
  });
});

// ============================================================================
// AI-043 — every reachable research entry point carries the CURRENT draft
//
// `researchCompanyComprehensive` derives the refreshed artifact's version from
// `existingResearch`. An entry point that omits it re-mints version 1 forever,
// so the review artifact identity never moves and a refresh cannot rescue an
// unreviewable draft. The original AI-043 fix added the argument to a refresh
// handler nothing rendered, while both reachable paths kept the old payload.
// ============================================================================

describe('buildComprehensiveResearchInput', () => {
  const DRAFT: CompanyResearch = { lastResearched: 5, version: 3 } as CompanyResearch;

  it('always carries the persisted draft so the refresh can advance the version', () => {
    const company = makeCompany({ id: 'c9', name: 'Helio', website: 'https://helio.example', research: DRAFT });

    expect(buildComprehensiveResearchInput(company)).toEqual({
      name: 'Helio',
      website: 'https://helio.example',
      description: undefined,
      existingResearch: DRAFT,
    });
  });

  it("prefers the sheet form's unsaved values but never drops the draft", () => {
    const company = makeCompany({ id: 'c9', name: 'Helio', website: '', research: DRAFT });

    expect(
      buildComprehensiveResearchInput(company, {
        name: '  Helio Renamed  ',
        website: 'https://renamed.example',
        description: 'edited in the form',
      })
    ).toEqual({
      name: 'Helio Renamed',
      website: 'https://renamed.example',
      description: 'edited in the form',
      existingResearch: DRAFT,
    });
  });

  it('omits the draft only when the company genuinely has none', () => {
    expect(buildComprehensiveResearchInput(makeCompany({ id: 'c9', name: 'Helio' })).existingResearch).toBeUndefined();
  });
});

describe('useCompaniesPage — research entry points carry the current draft (AI-043)', () => {
  const DRAFT: CompanyResearch = { lastResearched: 9, version: 4 } as CompanyResearch;

  it('passes the current draft from the sheet footer research button', async () => {
    const withDraft = { ...ACME, research: DRAFT };
    mockSelectedCompany = withDraft;
    mockedResearch.mockResolvedValue(MINIMAL_RESEARCH);
    mockedGetCompanyById.mockResolvedValue(withDraft);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.handleAIResearch?.('Acme', { website: '', description: '' });
    });

    expect(mockedResearch).toHaveBeenCalledWith(expect.objectContaining({ existingResearch: DRAFT }));
  });

  it('passes the current draft from the table row research action', async () => {
    const withDraft = { ...ACME, research: DRAFT };
    mockedResearch.mockResolvedValue(MINIMAL_RESEARCH);
    mockedGetCompanyById.mockResolvedValue(withDraft);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.handleResearchFromMenu(withDraft);
    });

    expect(mockedResearch).toHaveBeenCalledWith(expect.objectContaining({ existingResearch: DRAFT }));
  });

  it('reports research as in flight while the footer button runs', async () => {
    let resolveResearch!: (value: CompanyResearch) => void;
    mockSelectedCompany = ACME;
    mockedResearch.mockReturnValue(
      new Promise<CompanyResearch>((resolve) => {
        resolveResearch = resolve;
      })
    );
    mockedGetCompanyById.mockResolvedValue(ACME);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.handleAIResearch!('Acme');
    });
    expect(result.current.isResearchLoading).toBe(true);

    await act(async () => {
      resolveResearch(MINIMAL_RESEARCH);
      await pending;
    });
    expect(result.current.isResearchLoading).toBe(false);
  });
});

// ============================================================================
// HOOK — sheet footer delete (AUDIT-004 / F76)
// ============================================================================

describe('useCompaniesPage — handleDelete (sheet footer)', () => {
  it('actually deletes the selected company, then reloads and closes', async () => {
    mockSelectedCompany = ACME;
    mockedDeleteCompany.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockedGetCompanies.mockClear();

    await act(async () => {
      await result.current.handleDelete?.();
    });

    expect(mockedDeleteCompany).toHaveBeenCalledWith(ACME.id);
    // Deletion routes through handleDeleteCompany → toast + reload.
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Company Deleted' }));
    expect(mockedGetCompanies).toHaveBeenCalledTimes(1);
  });

  it('surfaces a destructive toast when deletion fails', async () => {
    mockSelectedCompany = ACME;
    mockedDeleteCompany.mockRejectedValue(new Error('delete blew up'));

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let deleted: boolean | void = undefined;
    await act(async () => {
      deleted = await result.current.handleDelete?.();
    });

    expect(deleted).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });

  it('is undefined when no company is selected', async () => {
    mockSelectedCompany = undefined;
    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.handleDelete).toBeUndefined();
  });
});

describe('useCompaniesPage — committed mutation truth and graph retry', () => {
  const formValues = {
    name: 'Acme Committed',
    description: 'Authoritative description',
    website: 'https://acme.example',
    type: ['startup'] as Company['type'],
    industry: ['technology'] as Company['industry'],
    industryCustom: [],
    size: 'small' as Company['size'],
    stage: 'seed' as Company['stage'],
    location: { city: 'Madrid', country: 'Spain' },
    status: 'Watching' as Company['status'],
    tags: ['quantum'],
    socialLinks: { linkedin: '', twitter: '', github: '' },
    technologyStack: [],
  };

  it('re-reads and renders a committed update when graph handoff is unacknowledged', async () => {
    mockSelectedCompany = ACME;
    const committed = makeCompany({
      ...ACME,
      id: ACME.id,
      name: 'Acme Committed',
      description: 'Authoritative description',
      updatedAt: 22,
    });
    mockedUpdateCompany.mockRejectedValueOnce(
      new EntitySyncDispatchError('company', ACME.id, 'update', new Error('route timed out'))
    );
    mockedGetCompanyById.mockResolvedValueOnce(committed);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.handleSave(formValues);
    });

    expect(mockedGetCompanyById).toHaveBeenCalledWith(ACME.id);
    expect(result.current.companies.find(({ id }) => id === ACME.id)).toEqual(committed);
    expect(result.current.graphSyncRecoveries[0]).toEqual(
      expect.objectContaining({
        entity: committed,
        entityId: ACME.id,
        operation: 'update',
        retryAttempts: 0,
      })
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Saved locally',
        description: expect.stringContaining('graph synchronization was not acknowledged'),
      })
    );
  });

  it('retries only the authenticated graph handoff after a committed create', async () => {
    const committed = makeCompany({ id: 'company-new', name: 'Acme Committed', updatedAt: 22 });
    mockedCreateCompany.mockRejectedValueOnce(
      new EntitySyncDispatchError('company', committed.id, 'create', new Error('graph disabled'))
    );
    mockedGetCompanyById.mockResolvedValueOnce(committed);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.handleAddCompany());

    await act(async () => {
      await result.current.handleSave(formValues);
    });
    await act(async () => {
      await result.current.retryGraphSync(committed.id);
    });

    expect(mockedCreateCompany).toHaveBeenCalledTimes(1);
    expect(mockedUpdateCompany).not.toHaveBeenCalled();
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockedFetchWithAuth.mock.calls[0][1]?.body as string)).toEqual({
      entityType: 'company',
      entityId: committed.id,
      operation: 'create',
    });
    // GRAPH-056: the row deliberately SURVIVES an acknowledged retry. Clearing
    // it here was the defect — the queue accepted the event, but Neo4j has not
    // written it yet, so reporting the entity as synced is a false claim. The
    // worker retires the durable anchor once the projection provably matches
    // the source, and the notice goes with it.
    expect(result.current.graphSyncRecoveries).toHaveLength(1);
    expect(result.current.graphSyncRecoveries[0]).toMatchObject({
      entityId: committed.id,
      awaitingConfirmation: true,
      isRetrying: false,
    });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Graph sync acknowledged' }));
  });

  it('keeps a rejected create distinct and does not offer graph retry', async () => {
    const rejection = new Error('permission denied');
    mockedCreateCompany.mockRejectedValueOnce(rejection);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.handleAddCompany());

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.handleSave(formValues);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBe(rejection);
    expect(mockedGetCompanyById).not.toHaveBeenCalled();
    expect(result.current.graphSyncRecoveries).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Company not saved', variant: 'destructive' })
    );
  });

  it('bounds one recovery episode at three graph-only attempts', async () => {
    mockSelectedCompany = ACME;
    const committed = makeCompany({ ...ACME, id: ACME.id, name: 'Acme Committed', updatedAt: 22 });
    mockedUpdateCompany.mockRejectedValueOnce(
      new EntitySyncDispatchError('company', ACME.id, 'update', new Error('route unavailable'))
    );
    mockedGetCompanyById.mockResolvedValueOnce(committed);
    mockedFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Graph synchronization handoff was not acknowledged' }),
    } as Response);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.handleSave(formValues);
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await act(async () => {
        await result.current.retryGraphSync(ACME.id);
      });
    }

    expect(mockedUpdateCompany).toHaveBeenCalledTimes(1);
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(3);
    expect(result.current.graphSyncRecoveries[0]?.retryAttempts).toBe(3);
  });

  it('does not hide an earlier unsynced company after an unrelated acknowledged save', async () => {
    mockSelectedCompany = ACME;
    const committed = makeCompany({ ...ACME, id: ACME.id, name: 'Acme Committed', updatedAt: 22 });
    mockedUpdateCompany.mockRejectedValueOnce(
      new EntitySyncDispatchError('company', ACME.id, 'update', new Error('route unavailable'))
    );
    mockedGetCompanyById.mockResolvedValueOnce(committed);

    const { result, rerender } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.handleSave(formValues);
    });

    mockSelectedCompany = BRAVO;
    rerender();
    await act(async () => {
      await result.current.handleSave({ ...formValues, name: BRAVO.name });
    });

    expect(result.current.graphSyncRecoveries[0]?.entityId).toBe(ACME.id);
    expect(mockedUpdateCompany).toHaveBeenLastCalledWith(BRAVO.id, expect.objectContaining({ name: BRAVO.name }));
  });
});

describe('useCompaniesPage — bulk delete selection', () => {
  it('retains only exact failed IDs after a partial result', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, deleted: 1, failed: ['c2'], relationsDeleted: 2 }),
    } as Response);
    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.toggleSelection(ACME);
      result.current.toggleSelection(BRAVO);
    });
    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['c2']);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Companies Partially Deleted', variant: 'destructive' })
    );
  });

  it('clears selection after an exact complete result', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, deleted: 2, failed: [], relationsDeleted: 0 }),
    } as Response);
    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.toggleSelection(ACME);
      result.current.toggleSelection(BRAVO);
    });
    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual([]);
  });

  it.each([
    {
      success: false,
      deleted: 1,
      failed: ['unknown'],
      relationsDeleted: 0,
    },
    {
      success: true,
      deleted: 0,
      failed: [],
      relationsDeleted: 0,
    },
  ])('keeps the original selection for an invalid acknowledgement %#', async (body) => {
    mockedFetchWithAuth.mockResolvedValue({ ok: true, json: async () => body } as Response);
    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.toggleSelection(ACME);
      result.current.toggleSelection(BRAVO);
    });
    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['c1', 'c2']);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });

  it('keeps the original selection when the route fails', async () => {
    mockedFetchWithAuth.mockResolvedValue({ ok: false } as Response);
    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.toggleSelection(ACME);
      result.current.toggleSelection(BRAVO);
    });
    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['c1', 'c2']);
  });
});

// ============================================================================
// HOOK — note edit persistence
// ============================================================================

describe('useCompaniesPage — handleUpdateNote', () => {
  it('persists an edit and refreshes local state without another read', async () => {
    mockSelectedCompany = ACME;
    mockedGetNotesByCompanyId.mockResolvedValue([ORIGINAL_NOTE]);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.companyNotes[ACME.id]?.[0]?.content).toBe('Original note'));

    await act(async () => {
      await result.current.handleUpdateNote?.(ORIGINAL_NOTE.id, EDITED_NOTE.content);
    });

    expect(mockedUpdateNote).toHaveBeenCalledWith(ACME.id, ORIGINAL_NOTE.id, { content: EDITED_NOTE.content });
    expect(mockedGetNotesByCompanyId).toHaveBeenCalledTimes(1);
    expect(result.current.companyNotes[ACME.id]?.[0]?.content).toBe('Edited note');
  });

  it('rethrows persistence failures so autosave reports an error', async () => {
    mockSelectedCompany = ACME;
    const saveError = new Error('write rejected');
    mockedGetNotesByCompanyId.mockResolvedValue([ORIGINAL_NOTE]);
    mockedUpdateNote.mockRejectedValue(saveError);

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.companyNotes[ACME.id]?.[0]?.content).toBe('Original note'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.handleUpdateNote?.(ORIGINAL_NOTE.id, 'Unsaved edit');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBe(saveError);
    expect(result.current.companyNotes[ACME.id]?.[0]?.content).toBe('Original note');
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});

// ============================================================================
// AI-028 — research draft truth (persistence guard + honest success copy)
// ============================================================================

describe('applyResearchToUpdate — AI-028 draft truth', () => {
  const RESEARCH_WITH_PROFILE = {
    lastResearched: 1,
    version: 1,
    executiveSummary: {
      overview: 'A cloud company.',
      keyHighlights: [],
      suggestedTags: ['cloud', 'enterprise'],
    },
    financialsAndTraction: {
      swot: {
        strengths: ['Fast'],
        weaknesses: [],
        opportunities: [],
        threats: [],
      },
    },
    companyProfile: {
      companyType: 'enterprise',
      size: 'enterprise',
      stage: 'public',
      industries: ['technology'],
      website: 'https://acme.example',
      headquarters: { city: 'Berlin', country: 'Germany' },
      socialLinks: { linkedin: 'https://linkedin.com/company/acme' },
    },
  } as unknown as CompanyResearch;

  it('persists only the unverified research draft and promotes no canonical company facts', () => {
    const update = applyResearchToUpdate(RESEARCH_WITH_PROFILE);

    expect(update).toEqual({ research: RESEARCH_WITH_PROFILE });
  });
});

describe('useCompaniesPage — research success copy', () => {
  it('reports a saved research DRAFT, never "Research Complete", on row-level research', async () => {
    mockedResearch.mockResolvedValue(MINIMAL_RESEARCH);
    mockedGetCompanyById.mockResolvedValue({ ...ACME, research: MINIMAL_RESEARCH });

    const { result } = renderHook(() => useCompaniesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.handleResearchFromMenu(ACME);
    });

    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Research Complete' }));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/draft/i) }));
    expect(mockedUpdateCompany).toHaveBeenLastCalledWith(ACME.id, { research: MINIMAL_RESEARCH });
  });
});
