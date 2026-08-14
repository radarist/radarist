/**
 * @file agents/linker/__tests__/page.test.tsx
 * @description P-F4: `/agents/linker` is now a legacy redirect stub — the
 * Linker Triage implementation moved to `/triage/relations`
 * (see `src/app/triage/relations/__tests__/page.test.tsx`). Pins that the
 * stub still forwards old links to the canonical route, mirroring the
 * `/agents/signals` → `/triage/signals` stub.
 */

const mockRedirect = jest.fn();
jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));

import AgentsLinkerRedirect from '../page';

describe('AgentsLinkerRedirect', () => {
  beforeEach(() => {
    mockRedirect.mockClear();
  });

  it('redirects to the canonical /triage/relations route', () => {
    AgentsLinkerRedirect();

    expect(mockRedirect).toHaveBeenCalledWith('/triage/relations');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });
});
