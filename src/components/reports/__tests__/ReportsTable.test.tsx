/**
 * @file ReportsTable.test.tsx
 * @description Pins the /reports title-rendering contract (P-B14):
 *
 * Entity decoding happens ONCE, at the read boundary (normalizeReportDoc in
 * src/lib/reports.ts) — so the table must render `report.title` VERBATIM.
 * These tests pin that the component does NOT decode: if a decode were
 * (re-)added here it would double-decode a stored "&amp;amp;" (an intentional
 * entity-literal title) down to "&". The decoded-display behavior itself is
 * covered at the boundary in src/lib/__tests__/reports.test.ts.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

// ReportsTable pulls in formatDate from useReportsPage -> useReports, which
// imports the Firebase client SDK + AuthProvider. Mock both to break the init
// chain rather than let the real SDK boot in jsdom.
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'test-user' }, loading: false }),
}));

import { ReportsTable } from '../ReportsTable';
import type { Report } from '@/lib/schemas/report';

beforeAll(() => {
  // Radix UI primitives touch these APIs which jsdom does not implement.
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
});

function makeReport(overrides: Partial<Report> & { id: string; title: string }): Report {
  return {
    html: '<html></html>',
    createdAt: new Date().toISOString(),
    createdBy: 'agent',
    agentType: 'creator',
    entityIds: [],
    metadata: { description: '', dataSnapshotAt: new Date().toISOString() },
    shared: false,
    ...overrides,
  } as Report;
}

function renderTable(reports: Report[]) {
  render(
    <ReportsTable
      reports={reports}
      onDeleteReport={jest.fn()}
      onShareReport={jest.fn()}
      onDownloadReport={jest.fn()}
      isSelected={() => false}
      onToggleSelection={jest.fn()}
      isAllSelected={false}
      isSomeSelected={false}
      onSelectAllChange={jest.fn()}
      sortState={{ key: 'title', direction: 'asc' }}
      onSort={jest.fn()}
    />
  );
}

describe('ReportsTable — verbatim title rendering (decode lives at the read boundary)', () => {
  it('renders an already-decoded title as-is in cell, tooltip attribute, and checkbox aria-label', () => {
    // This is what the read boundary hands the UI for the real corrupted doc.
    const decoded = makeReport({
      id: 'r-decoded',
      title: 'The Agentic PKG Harness V2 — Architecture, MCP & The Production Reality Check',
    });
    renderTable([decoded]);

    const cell = screen.getByText('The Agentic PKG Harness V2 — Architecture, MCP & The Production Reality Check');
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveAttribute(
      'title',
      'The Agentic PKG Harness V2 — Architecture, MCP & The Production Reality Check'
    );
    expect(
      screen.getByRole('checkbox', {
        name: 'Select The Agentic PKG Harness V2 — Architecture, MCP & The Production Reality Check',
      })
    ).toBeInTheDocument();
  });

  it('does NOT decode in the component — a title containing an entity literal renders literally', () => {
    // After the read boundary decodes stored "&amp;amp;" once, the UI receives
    // the literal string "&amp;". A component-level decode would collapse it
    // to "&" (double-decode) — this test fails if one is reintroduced.
    const entityLiteral = makeReport({ id: 'r-literal', title: 'Escaping guide: use &amp; for ampersands' });
    renderTable([entityLiteral]);

    const cell = screen.getByText('Escaping guide: use &amp; for ampersands');
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveAttribute('title', 'Escaping guide: use &amp; for ampersands');
    expect(screen.queryByText('Escaping guide: use & for ampersands')).toBeNull();
  });

  it('leaves a plain title unchanged', () => {
    const plain = makeReport({ id: 'r-plain', title: 'Clean Report Title' });
    renderTable([plain]);

    expect(screen.getByText('Clean Report Title')).toBeInTheDocument();
  });
});

describe('ReportsTable — row click navigation (P-F2)', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
  });

  it('navigates to the report detail route when the row is clicked', () => {
    const report = makeReport({ id: 'r-nav', title: 'Quarterly Update' });
    renderTable([report]);

    fireEvent.click(screen.getByText('Quarterly Update'));

    expect(mockRouterPush).toHaveBeenCalledWith('/reports/r-nav');
  });

  it('does not navigate when the row actions (⋯) menu is clicked', () => {
    const report = makeReport({ id: 'r-menu', title: 'Annual Report' });
    renderTable([report]);

    fireEvent.click(screen.getByRole('button', { name: 'Report actions' }));

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('does not navigate when the row checkbox is clicked', () => {
    const report = makeReport({ id: 'r-checkbox', title: 'Monthly Digest' });
    renderTable([report]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Monthly Digest' }));

    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
