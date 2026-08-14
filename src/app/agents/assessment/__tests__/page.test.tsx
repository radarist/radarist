/**
 * @file agents/assessment/__tests__/page.test.tsx
 * @description P-F4: `/agents/assessment` is now a legacy redirect stub — the
 * Assessment inbox implementation moved to `/triage/assessment`. Pins that
 * the stub still forwards old links to the canonical route, mirroring the
 * `/agents/signals` → `/triage/signals` stub.
 */

const mockRedirect = jest.fn();
jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));

import AgentsAssessmentRedirect from '../page';

describe('AgentsAssessmentRedirect', () => {
  beforeEach(() => {
    mockRedirect.mockClear();
  });

  it('redirects to the canonical /triage/assessment route', () => {
    AgentsAssessmentRedirect();

    expect(mockRedirect).toHaveBeenCalledWith('/triage/assessment');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });
});
