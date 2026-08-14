/**
 * @file ViewModeToggle.test.tsx
 * @description Tests the toggle's read-from-store + write-to-store loop.
 *
 * Doesn't mock the store — the persist layer is exercised by the
 * store's own test file. Here we verify the component reflects the
 * live state and writes back on click.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { ViewModeToggle } from '../ViewModeToggle';
import { useBriefingUIStore } from '@/stores/briefing-ui-store';

describe('ViewModeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useBriefingUIStore.setState({ viewMode: 'table' });
    });
  });

  it('marks the active mode with aria-pressed', () => {
    render(<ViewModeToggle />);
    expect(screen.getByTestId('briefing-view-mode-table')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('briefing-view-mode-card')).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to card when the card button is clicked', () => {
    render(<ViewModeToggle />);
    fireEvent.click(screen.getByTestId('briefing-view-mode-card'));
    expect(useBriefingUIStore.getState().viewMode).toBe('card');
  });

  it('switches back to table when the table button is clicked', () => {
    render(<ViewModeToggle />);
    fireEvent.click(screen.getByTestId('briefing-view-mode-card'));
    fireEvent.click(screen.getByTestId('briefing-view-mode-table'));
    expect(useBriefingUIStore.getState().viewMode).toBe('table');
  });
});
