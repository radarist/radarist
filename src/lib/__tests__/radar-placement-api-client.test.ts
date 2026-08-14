/**
 * @jest-environment jsdom
 *
 * GRAPH-060 — the browser placement API client. Confirms the client posts to
 * RELATIVE same-origin paths (works under any shifted port / with no public app
 * base URL), threads the response envelope, and surfaces server errors.
 */
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

const mockToastWarning = jest.fn();
jest.mock('sonner', () => ({ toast: { warning: mockToastWarning } }));

const { fetchWithAuth } = jest.requireMock('@/lib/fetch-with-auth') as { fetchWithAuth: jest.Mock };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

import {
  isBrowserRadarPlacementClient,
  createRadarPlacementViaApi,
  updateRadarPlacementViaApi,
  deleteRadarPlacementViaApi,
} from '../radar-placement-api-client';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const CREATE_INPUT = {
  technologyId: 'tech-1',
  radarId: 'radar-1',
  quadrantId: 'techniques',
  ring: 'Trial',
  placedBy: 'user-1',
} as const;

beforeEach(() => jest.clearAllMocks());

describe('isBrowserRadarPlacementClient', () => {
  it('is true in a browser (window-defined) environment', () => {
    expect(isBrowserRadarPlacementClient()).toBe(true);
  });
});

describe('createRadarPlacementViaApi', () => {
  it('POSTs to the relative same-origin path (shifted-port / no public base URL safe)', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { id: 'placement-1', ...CREATE_INPUT } }, true, 201)
    );

    const result = await createRadarPlacementViaApi(CREATE_INPUT);

    expect(result.id).toBe('placement-1');
    const [url, init] = fetchWithAuth.mock.calls[0];
    // A relative path — never an absolute URL with a host/port. This is what
    // makes the handoff work under the shifted-port emulator lane and with no
    // configured public app base URL.
    expect(url).toBe('/api/radar-placements');
    expect(url.startsWith('http')).toBe(false);
    expect(init.method).toBe('POST');
  });

  it('throws with the server message when the envelope reports failure', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ success: false, message: 'Technology tech-1 is already placed on radar radar-1' }, false, 409)
    );

    await expect(createRadarPlacementViaApi(CREATE_INPUT)).rejects.toThrow('already placed');
  });
});

describe('updateRadarPlacementViaApi', () => {
  it('PATCHes the relative item path with the id encoded', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 'placement-1', ring: 'Adopt' } }));

    const result = await updateRadarPlacementViaApi('placement-1', { ring: 'Adopt' });

    expect(result.ring).toBe('Adopt');
    const [url, init] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/api/radar-placements/placement-1');
    expect(init.method).toBe('PATCH');
  });
});

describe('deleteRadarPlacementViaApi', () => {
  it('DELETEs the relative item path and resolves void', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ success: true, data: { deleted: true } }));

    await expect(deleteRadarPlacementViaApi('placement-1')).resolves.toBeUndefined();
    const [url, init] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/api/radar-placements/placement-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('#2 graphHandoff propagation to the visible UI', () => {
  it('warns the user (reconciliation pending) on a committed-but-unacknowledged create', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonResponse(
        {
          success: true,
          data: { id: 'placement-1', ...CREATE_INPUT },
          graphHandoff: { committed: true, acknowledged: false, reconciliationRequired: true },
        },
        true,
        201
      )
    );

    await createRadarPlacementViaApi(CREATE_INPUT);
    await flush();

    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    const [title, opts] = mockToastWarning.mock.calls[0];
    // Says the change is saved + reconciliation pending; never rollback/failure.
    expect(String(title).toLowerCase()).toContain('saved');
    const message = `${title} ${opts?.description ?? ''}`.toLowerCase();
    expect(message).not.toMatch(/rollback|failed|converged/);
    // No keys / internal URLs / ports leaked.
    expect(message).not.toMatch(/http|:\d{2,5}|inngest|key/);
  });

  it('does NOT warn on an ordinary acknowledged success', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { id: 'placement-2', ...CREATE_INPUT },
        graphHandoff: { committed: true, acknowledged: true, reconciliationRequired: false },
      })
    );

    await createRadarPlacementViaApi(CREATE_INPUT);
    await flush();

    expect(mockToastWarning).not.toHaveBeenCalled();
  });
});
