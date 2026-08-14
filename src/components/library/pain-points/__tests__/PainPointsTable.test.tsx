/**
 * @file PainPointsTable.test.tsx
 * @description UX-059 regression — the table view renders a normalized sparse
 * (triage-created) Pain Point without crashing, showing zero affected org
 * units. The boundary normalizer guarantees array fields, so the table can keep
 * using direct `.length` access without scattered optional chaining.
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

import { PainPointsTable } from '../PainPointsTable';
import { normalizePainPointForRead } from '@/lib/pain-points-shared';
import type { PainPoint } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';

// JSDOM polyfills for Radix primitives.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// A sparse scout-approved record exactly as stored before the boundary fix.
const sparseRaw = {
  id: 'painpoint-sparse-table',
  slug: 'sparse-table',
  title: 'Sparse Scout Pain',
  description: 'Surfaced by the scout with no org units',
  severity: 'medium',
  status: 'identified',
  category: 'operational',
  tags: [],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

function makeProps(painPoints: PainPoint[]) {
  return {
    painPoints,
    selectedIds: new Set<string>(),
    sortConfig: null as SortConfig | null,
    onSort: jest.fn(),
    onSelectAll: jest.fn(),
    onSelectOne: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
  };
}

describe('PainPointsTable (UX-059 sparse rendering)', () => {
  it('renders a normalized sparse record and shows 0 affected org units', () => {
    const normalized = [normalizePainPointForRead(sparseRaw) as PainPoint];
    render(<PainPointsTable {...makeProps(normalized)} />);

    expect(screen.getByText('Sparse Scout Pain')).toBeInTheDocument();
    // The Affected column renders the count (0) without crashing.
    expect(screen.getByText('0')).toBeInTheDocument();
    // Direct array access used by the component is safe post-normalization.
    expect(normalized[0].affectedOrgUnitIds.length).toBe(0);
  });

  it('renders a populated record with the correct affected-unit count', () => {
    const populated = normalizePainPointForRead({
      ...sparseRaw,
      id: 'painpoint-full',
      title: 'Full Pain',
      affectedOrgUnitIds: ['org-1', 'org-2', 'org-3'],
      tags: ['a', 'b'],
    }) as PainPoint;
    render(<PainPointsTable {...makeProps([populated])} />);

    expect(screen.getByText('Full Pain')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('opens edit when a row is clicked', () => {
    const onEdit = jest.fn();
    const normalized = [normalizePainPointForRead(sparseRaw) as PainPoint];
    render(<PainPointsTable {...makeProps(normalized)} onEdit={onEdit} />);

    fireEvent.click(screen.getByText('Sparse Scout Pain'));
    expect(onEdit).toHaveBeenCalledWith(normalized[0]);
  });
});
