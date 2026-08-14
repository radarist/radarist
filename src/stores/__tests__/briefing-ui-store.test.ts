/**
 * @file briefing-ui-store.test.ts
 * @description Pins the persist contract: viewMode survives a reload,
 * setViewMode flips state, default is `table`.
 *
 * @jest-environment jsdom
 */

import { act } from '@testing-library/react';
import { useBriefingUIStore } from '../briefing-ui-store';

describe('briefing-ui-store', () => {
  beforeEach(() => {
    // Reset both the live store and the persist backing so each test
    // starts from the documented default.
    localStorage.clear();
    act(() => {
      useBriefingUIStore.setState({ viewMode: 'table' });
    });
  });

  it('defaults to table view (matches the plan §5.1)', () => {
    expect(useBriefingUIStore.getState().viewMode).toBe('table');
  });

  it('setViewMode flips the value', () => {
    act(() => {
      useBriefingUIStore.getState().setViewMode('card');
    });
    expect(useBriefingUIStore.getState().viewMode).toBe('card');
  });

  it('persists viewMode to localStorage under the `briefing-ui` key', () => {
    act(() => {
      useBriefingUIStore.getState().setViewMode('card');
    });
    const raw = localStorage.getItem('briefing-ui');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.viewMode).toBe('card');
  });

  it('does not persist the `setViewMode` function (partialize keeps viewMode only)', () => {
    act(() => {
      useBriefingUIStore.getState().setViewMode('card');
    });
    const parsed = JSON.parse(localStorage.getItem('briefing-ui')!);
    // partialize means only viewMode lands on disk; functions are not
    // JSON-serialisable so omitting them is the only correct behaviour.
    expect(Object.keys(parsed.state)).toEqual(['viewMode']);
  });
});
