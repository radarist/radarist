/**
 * @file PainPointsGrid.test.tsx
 * @description UX-059 regression — the grid view renders a normalized sparse
 * (triage-created) Pain Point without a tags crash. The boundary normalizer
 * guarantees the `tags` and `affectedOrgUnitIds` arrays, so the grid keeps
 * using direct `.length`/`.slice` access without scattered optional chaining.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { PainPointsGrid } from '../PainPointsGrid';
import { normalizePainPointForRead } from '@/lib/pain-points-shared';
import type { PainPoint } from '@/lib/types';

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

const sparseRaw = {
  id: 'painpoint-sparse-grid',
  slug: 'sparse-grid',
  title: 'Sparse Grid Pain',
  description: 'No tags, no org units',
  severity: 'low',
  status: 'identified',
  category: 'customer',
  // tags intentionally omitted — the pre-fix crash site.
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

function makeProps(painPoints: PainPoint[]) {
  return {
    painPoints,
    selectedIds: new Set<string>(),
    onSelectOne: jest.fn(),
    onEdit: jest.fn(),
  };
}

describe('PainPointsGrid (UX-059 sparse rendering)', () => {
  it('renders a normalized sparse record without a tags crash', () => {
    const normalized = [normalizePainPointForRead(sparseRaw) as PainPoint];
    expect(() => render(<PainPointsGrid {...makeProps(normalized)} />)).not.toThrow();

    expect(screen.getByText('Sparse Grid Pain')).toBeInTheDocument();
    expect(screen.getByText(/0 affected org units/i)).toBeInTheDocument();
    expect(
      screen.getByTestId('pain-point-card-painpoint-sparse-grid'),
    ).toBeInTheDocument();
  });

  it('renders tag badges for a populated record and a +N overflow chip', () => {
    const populated = normalizePainPointForRead({
      ...sparseRaw,
      id: 'painpoint-tagged',
      title: 'Tagged Pain',
      affectedOrgUnitIds: ['org-1'],
      tags: ['one', 'two', 'three', 'four', 'five'],
    }) as PainPoint;
    render(<PainPointsGrid {...makeProps([populated])} />);

    expect(screen.getByText('Tagged Pain')).toBeInTheDocument();
    expect(screen.getByText(/1 affected org unit/i)).toBeInTheDocument();
    // First three tags render, plus an overflow chip (+2).
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.getByText('three')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('renders an empty record with exactly one affected-unit line and no tag badges', () => {
    const normalized = [normalizePainPointForRead(sparseRaw) as PainPoint];
    render(<PainPointsGrid {...makeProps(normalized)} />);

    expect(screen.getByText(/0 affected org units/i)).toBeInTheDocument();
    // No tag badges for a tag-less record.
    expect(screen.queryByText('+1')).not.toBeInTheDocument();
  });
});
