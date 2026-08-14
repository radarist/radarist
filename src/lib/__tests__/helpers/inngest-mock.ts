/**
 * Shared Inngest mock helper
 *
 * Usage:
 *   const { inngestMock, getRegisteredHandler } = createInngestMock();
 *   jest.mock('@/lib/inngest/client', () => inngestMock);
 */

type HandlerFn = (...args: unknown[]) => unknown;

export function createInngestMock() {
  const handlers = new Map<string, HandlerFn>();

  const inngestMock = {
    inngest: {
      createFunction: jest.fn((config: { id: string }, trigger: unknown, handler: HandlerFn) => {
        handlers.set(config.id, handler);
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue({ ids: ['mock-event-id'] }),
    },
  };

  return {
    inngestMock,
    getRegisteredHandler: (id: string) => handlers.get(id),
    resetHandlers: () => handlers.clear(),
  };
}
