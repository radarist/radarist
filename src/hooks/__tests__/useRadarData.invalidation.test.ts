/**
 * @jest-environment node
 *
 * UX-043 — quadrant-config mutations must refresh the TanStack caches the
 * entries sidebar derives quadrant names from.
 */

import { QueryClient } from '@tanstack/react-query';

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  onSnapshot: jest.fn(),
  query: jest.fn(),
  doc: jest.fn(),
  writeBatch: jest.fn(),
  updateDoc: jest.fn(),
  getDocs: jest.fn(),
}));

import { invalidateRadarDerivedQueries } from '../useRadarData';
import { radarKeys, technologyKeys } from '@/lib/query-keys';

describe('invalidateRadarDerivedQueries (UX-043)', () => {
  it('invalidates the radar detail and placements queries for exactly the edited radar', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    invalidateRadarDerivedQueries(queryClient, 'radar-42');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: radarKeys.detail('radar-42') });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: technologyKeys.withPlacements('radar-42'),
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
