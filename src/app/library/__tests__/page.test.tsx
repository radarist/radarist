/**
 * @file app/library/__tests__/page.test.tsx
 * @description Regression tests for the /library landing page stats.
 *
 * Pins the fix for the "Technologies: 0" bug: the hub previously counted
 * docs in the legacy `radars/{id}/entries` subcollection (which the
 * decoupled Technology model never writes), while /library/technologies
 * counted the `technologies` collection. The landing page must now source
 * its Technologies count from `getTechnologies()` (technologies collection)
 * and never touch Firestore subcollections directly.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Layout chrome — passthrough mock. SmartLayout pulls in heavy sidebar deps,
// so we stub it down to a div for unit-scope mounting.
// ---------------------------------------------------------------------------
jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

// ---------------------------------------------------------------------------
// lucide-react ESM proxy stub — Jest's CJS transform can't load lucide
// directly. Render every icon as a tagged span.
// ---------------------------------------------------------------------------
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => makeIcon(prop),
    }
  );
});

// ---------------------------------------------------------------------------
// Firebase — break the init chain AND spy on the client SDK. The page must
// no longer call getDocs/collection itself (the legacy radar-entries count
// path was removed), so the firestore mock doubles as a regression tripwire.
// ---------------------------------------------------------------------------
const mockGetDocs = jest.fn();
const mockCollection = jest.fn();
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
// Lazy wrappers: jest.mock factories are hoisted above the const initializers,
// so referencing the mock fns directly would hit the TDZ during module load.
jest.mock('firebase/firestore', () => ({
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  collection: (...args: unknown[]) => mockCollection(...args),
}));

// ---------------------------------------------------------------------------
// Logger — keep output quiet and let the error-path test assert on it.
// ---------------------------------------------------------------------------
const mockLogError = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    // Lazy wrapper — createLogger() runs at page-module load, before the
    // hoisting-safe const above is initialized.
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}));

// ---------------------------------------------------------------------------
// Entity services — one mock per service the stats loader fans out to.
// Distinct counts per entity type so each KPI value is unambiguous.
// ---------------------------------------------------------------------------
jest.mock('@/lib/companies', () => ({ getCompanies: jest.fn() }));
jest.mock('@/lib/technology-service', () => ({ getTechnologies: jest.fn() }));
jest.mock('@/lib/use-cases', () => ({ getUseCases: jest.fn() }));
jest.mock('@/lib/prototypes', () => ({ getPrototypes: jest.fn() }));
jest.mock('@/lib/strategies', () => ({ getStrategies: jest.fn() }));
jest.mock('@/lib/org-units', () => ({ getOrgUnits: jest.fn() }));
jest.mock('@/lib/initiatives', () => ({ getInitiatives: jest.fn() }));
jest.mock('@/lib/pain-points', () => ({ getPainPoints: jest.fn() }));
jest.mock('@/lib/document-service', () => ({ getDocuments: jest.fn() }));

import { getCompanies } from '@/lib/companies';
import { getTechnologies } from '@/lib/technology-service';
import { getUseCases } from '@/lib/use-cases';
import { getPrototypes } from '@/lib/prototypes';
import { getStrategies } from '@/lib/strategies';
import { getOrgUnits } from '@/lib/org-units';
import { getInitiatives } from '@/lib/initiatives';
import { getPainPoints } from '@/lib/pain-points';
import { getDocuments } from '@/lib/document-service';

import LibraryPage from '../page';

/** Builds n minimal entity stubs — the page only reads `.length`. */
const items = (n: number): Array<{ id: string }> => Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));

/** Mirrors the seed: 17 docs in the `technologies` collection. */
const TECH_COUNT = 17;

function seedHappyPath(): void {
  (getCompanies as jest.Mock).mockResolvedValue(items(3));
  (getTechnologies as jest.Mock).mockResolvedValue(items(TECH_COUNT));
  (getUseCases as jest.Mock).mockResolvedValue(items(4));
  (getPrototypes as jest.Mock).mockResolvedValue(items(5));
  (getStrategies as jest.Mock).mockResolvedValue(items(6));
  (getOrgUnits as jest.Mock).mockResolvedValue(items(7));
  (getInitiatives as jest.Mock).mockResolvedValue(items(8));
  (getPainPoints as jest.Mock).mockResolvedValue(items(9));
  (getDocuments as jest.Mock).mockResolvedValue(items(2));
}

describe('LibraryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedHappyPath();
  });

  it('counts Technologies from the technologies collection via getTechnologies()', async () => {
    render(<LibraryPage />);

    // KPI card renders the bare value once loading settles.
    expect(await screen.findByText(String(TECH_COUNT))).toBeInTheDocument();
    // Section card renders "<count> items" for the same source.
    expect(screen.getByText(`${TECH_COUNT} items`)).toBeInTheDocument();

    expect(getTechnologies).toHaveBeenCalledTimes(1);
  });

  it('never queries the legacy radars/{id}/entries subcollection', async () => {
    render(<LibraryPage />);

    await screen.findByText(String(TECH_COUNT));

    // The dead subcollection-count path was removed outright — the page must
    // not reach for the Firestore client SDK at all.
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(mockCollection).not.toHaveBeenCalled();
  });

  it('shows the loading placeholder before stats resolve', async () => {
    render(<LibraryPage />);

    // KPICard renders "-" while isLoading; 9 KPIs are in flight.
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);

    // Settles to real values afterwards.
    expect(await screen.findByText(String(TECH_COUNT))).toBeInTheDocument();
  });

  it('renders an honest error note (not all-zero KPI tiles) when a stats fetch fails (AUDIT-008)', async () => {
    (getTechnologies as jest.Mock).mockRejectedValue(new Error('firestore unavailable'));

    render(<LibraryPage />);

    await waitFor(() => expect(mockLogError).toHaveBeenCalled());

    // The KPI row is replaced by the error note with a Retry affordance.
    expect(await screen.findByText('Could not load library statistics')).toBeInTheDocument();
    expect(screen.getByText('firestore unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // Section cards keep the "-" placeholder instead of lying with 0s, and no
    // fake counts render anywhere.
    expect(screen.getAllByText('- items').length).toBeGreaterThan(0);
    expect(screen.queryByText(String(TECH_COUNT))).not.toBeInTheDocument();
    expect(screen.queryByText('0 items')).not.toBeInTheDocument();
  });

  it('recovers when Retry succeeds after a failed stats fetch', async () => {
    (getTechnologies as jest.Mock).mockRejectedValueOnce(new Error('firestore unavailable'));

    render(<LibraryPage />);
    await screen.findByText('Could not load library statistics');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(String(TECH_COUNT))).toBeInTheDocument();
    expect(screen.queryByText('Could not load library statistics')).not.toBeInTheDocument();
  });

  it('renders all nine entity KPI labels', async () => {
    render(<LibraryPage />);
    await screen.findByText(String(TECH_COUNT));

    for (const label of [
      'Companies',
      'Technologies',
      'Strategies',
      'Use Cases',
      'Prototypes',
      'Org Units',
      'Initiatives',
      'Pain Points',
      'Documents',
    ]) {
      // Label appears on both the KPI card and the section card.
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
  });
});
