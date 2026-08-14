/**
 * Shared Neo4j mock helper
 *
 * Usage:
 *   const { neo4jMock, mockSession } = createNeo4jMock();
 *   jest.mock('neo4j-driver', () => neo4jMock);
 */

export function createNeo4jMock() {
  const mockRun = jest.fn().mockResolvedValue({ records: [] });

  const mockSession = {
    run: mockRun,
    close: jest.fn().mockResolvedValue(undefined),
    beginTransaction: jest.fn().mockReturnValue({
      run: mockRun,
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    }),
  };

  const mockDriver = {
    session: jest.fn().mockReturnValue(mockSession),
    close: jest.fn().mockResolvedValue(undefined),
    verifyConnectivity: jest.fn().mockResolvedValue(undefined),
  };

  const neo4jMock = {
    default: {
      driver: jest.fn().mockReturnValue(mockDriver),
      auth: {
        basic: jest.fn().mockReturnValue({}),
      },
      int: jest.fn((n: number) => ({ toNumber: () => n })),
    },
    driver: jest.fn().mockReturnValue(mockDriver),
    auth: {
      basic: jest.fn().mockReturnValue({}),
    },
    int: jest.fn((n: number) => ({ toNumber: () => n })),
  };

  return {
    neo4jMock,
    mockDriver,
    mockSession,
    mockRun,
    mockQueryResult: (records: Array<Record<string, unknown>>) => {
      mockRun.mockResolvedValueOnce({
        records: records.map(r => ({
          get: (key: string) => r[key],
          toObject: () => r,
          keys: Object.keys(r),
        })),
      });
    },
  };
}
