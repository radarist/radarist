/**
 * @jest-environment jsdom
 *
 * GRAPH-060 — the client `radar-placement-service` must route browser
 * create/update/move/delete through the authenticated same-origin API client,
 * NOT through a direct Firestore write + client-side Inngest send (the path that
 * silently swallowed the graph handoff). This pins the browser branch: the API
 * client is called and the direct Firestore `setDoc`/`deleteDoc` writes never
 * run in a browser context.
 */
jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  getDocs: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  writeBatch: jest.fn(),
}));
const mockFirestore = jest.requireMock('firebase/firestore') as Record<string, jest.Mock>;

jest.mock('@/lib/entity-sync', () => ({ triggerEntitySync: jest.fn() }));
jest.mock('@/lib/events/data-refresh', () => ({ emitDataRefresh: jest.fn() }));

jest.mock('@/lib/radar-placement-api-client', () => ({
  isBrowserRadarPlacementClient: jest.fn(() => true),
  createRadarPlacementViaApi: jest.fn(),
  updateRadarPlacementViaApi: jest.fn(),
  deleteRadarPlacementViaApi: jest.fn(),
  deleteAllPlacementsForTechnologyViaApi: jest.fn(),
  deleteAllPlacementsForRadarViaApi: jest.fn(),
}));

const apiClient = jest.requireMock('@/lib/radar-placement-api-client') as {
  isBrowserRadarPlacementClient: jest.Mock;
  createRadarPlacementViaApi: jest.Mock;
  updateRadarPlacementViaApi: jest.Mock;
  deleteRadarPlacementViaApi: jest.Mock;
  deleteAllPlacementsForTechnologyViaApi: jest.Mock;
  deleteAllPlacementsForRadarViaApi: jest.Mock;
};

import {
  createRadarPlacement,
  updateRadarPlacement,
  moveTechnologyRing,
  deleteRadarPlacement,
  deleteAllPlacementsForTechnology,
  deleteAllPlacementsForRadar,
} from '../radar-placement-service';

const CREATE_INPUT = {
  technologyId: 'tech-1',
  radarId: 'radar-1',
  quadrantId: 'techniques',
  ring: 'Trial' as const,
  placedBy: 'user-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  apiClient.isBrowserRadarPlacementClient.mockReturnValue(true);
});

describe('radar-placement-service browser handoff (GRAPH-060)', () => {
  it('create delegates to the API client and never writes Firestore directly', async () => {
    apiClient.createRadarPlacementViaApi.mockResolvedValueOnce({ id: 'placement-1', ...CREATE_INPUT });

    const result = await createRadarPlacement(CREATE_INPUT);

    expect(result.id).toBe('placement-1');
    expect(apiClient.createRadarPlacementViaApi).toHaveBeenCalledWith(CREATE_INPUT);
    expect(mockFirestore.setDoc).not.toHaveBeenCalled();
  });

  it('update delegates to the API client and never writes Firestore directly', async () => {
    apiClient.updateRadarPlacementViaApi.mockResolvedValueOnce({ id: 'placement-1', ring: 'Adopt' });

    const result = await updateRadarPlacement('placement-1', { ring: 'Adopt' });

    expect(result.ring).toBe('Adopt');
    expect(apiClient.updateRadarPlacementViaApi).toHaveBeenCalledWith('placement-1', { ring: 'Adopt' });
    expect(mockFirestore.updateDoc).not.toHaveBeenCalled();
  });

  it('move (ring change) delegates through the update API client', async () => {
    apiClient.updateRadarPlacementViaApi.mockResolvedValueOnce({ id: 'placement-1', ring: 'Adopt' });

    await moveTechnologyRing('placement-1', 'Adopt', 'Ready for production');

    expect(apiClient.updateRadarPlacementViaApi).toHaveBeenCalledWith(
      'placement-1',
      expect.objectContaining({ ring: 'Adopt', rationale: 'Ready for production' })
    );
  });

  it('delete delegates to the API client and never deletes Firestore directly', async () => {
    apiClient.deleteRadarPlacementViaApi.mockResolvedValueOnce(undefined);

    await deleteRadarPlacement('placement-1');

    expect(apiClient.deleteRadarPlacementViaApi).toHaveBeenCalledWith('placement-1');
    expect(mockFirestore.deleteDoc).not.toHaveBeenCalled();
  });
});

describe('#1 browser bulk cascades route through the server API (no Web-SDK batch writes)', () => {
  it('deleteAllPlacementsForTechnology delegates to the API and never touches Firestore', async () => {
    apiClient.deleteAllPlacementsForTechnologyViaApi.mockResolvedValueOnce(3);
    const count = await deleteAllPlacementsForTechnology('tech-1');
    expect(count).toBe(3);
    expect(apiClient.deleteAllPlacementsForTechnologyViaApi).toHaveBeenCalledWith('tech-1');
    expect(mockFirestore.writeBatch).not.toHaveBeenCalled();
    expect(mockFirestore.deleteDoc).not.toHaveBeenCalled();
  });

  it('deleteAllPlacementsForRadar delegates to the API and never touches Firestore', async () => {
    apiClient.deleteAllPlacementsForRadarViaApi.mockResolvedValueOnce(5);
    const count = await deleteAllPlacementsForRadar('radar-1');
    expect(count).toBe(5);
    expect(apiClient.deleteAllPlacementsForRadarViaApi).toHaveBeenCalledWith('radar-1');
    expect(mockFirestore.writeBatch).not.toHaveBeenCalled();
  });
});
