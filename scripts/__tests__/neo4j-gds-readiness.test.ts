/** @jest-environment node */

import {
  NEO4J_GDS_VERSION_QUERY,
  Neo4jGdsReadinessError,
  waitForNeo4jGdsReadiness,
  type Neo4jGdsDriverFactoryInput,
  type Neo4jGdsProbeDriver,
  type Neo4jGdsProbeSession,
} from '../lib/neo4j-gds-readiness';

const ENV = {
  NEO4J_URI: 'bolt://127.0.0.1:7687',
  NEO4J_USER: 'operator',
  NEO4J_PASSWORD: 'private-password',
  NEO4J_DATABASE: 'radarist',
};

interface FakeAttempt {
  value?: unknown;
  error?: unknown;
  closeError?: unknown;
}

function fakeDriver(attempts: FakeAttempt[], driverCloseError?: unknown) {
  const sessions: Array<{
    probeVersion: jest.Mock;
    close: jest.Mock;
  }> = [];
  const openReadSession = jest.fn((_database: string): Neo4jGdsProbeSession => {
    const attempt = attempts.shift();
    if (!attempt) throw new Error('Unexpected extra GDS readiness attempt');
    const probeVersion = jest.fn(async () => {
      if (attempt.error !== undefined) throw attempt.error;
      return attempt.value;
    });
    const close = jest.fn(async () => {
      if (attempt.closeError !== undefined) throw attempt.closeError;
    });
    sessions.push({ probeVersion, close });
    return { probeVersion, close };
  });
  const close = jest.fn(async () => {
    if (driverCloseError !== undefined) throw driverCloseError;
  });
  const driver: Neo4jGdsProbeDriver = { openReadSession, close };
  return { driver, sessions, openReadSession, close };
}

describe('waitForNeo4jGdsReadiness', () => {
  it('uses authenticated config, returns a trimmed version, and closes the session and driver', async () => {
    const fake = fakeDriver([{ value: ' 2.6.9 ' }]);
    const factory = jest.fn((_input: Neo4jGdsDriverFactoryInput) => fake.driver);

    // The query budget is the attempt deadline MINUS the time already spent
    // opening the session, so with the real clock this assertion only held when
    // both `Date.now()` reads landed in the same millisecond — it observed 24
    // otherwise. Freeze the injected clock: the exact budget stays asserted,
    // the millisecond race does not decide whether the gate passes.
    await expect(
      waitForNeo4jGdsReadiness(
        ENV,
        { timeoutMs: 100, attemptTimeoutMs: 25, pollIntervalMs: 5 },
        { createDriver: factory, now: () => 1_000 }
      )
    ).resolves.toBe('2.6.9');

    expect(factory).toHaveBeenCalledWith({
      uri: ENV.NEO4J_URI,
      username: ENV.NEO4J_USER,
      password: ENV.NEO4J_PASSWORD,
      database: ENV.NEO4J_DATABASE,
      connectionAcquisitionTimeoutMs: 25,
      connectionTimeoutMs: 25,
    });
    expect(fake.openReadSession).toHaveBeenCalledWith('radarist');
    expect(fake.sessions[0]?.probeVersion).toHaveBeenCalledWith(NEO4J_GDS_VERSION_QUERY, 25);
    expect(fake.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('preserves password bytes exactly while rejecting whitespace-only credentials', async () => {
    const fake = fakeDriver([{ value: '2.6.9' }]);
    const factory = jest.fn((_input: Neo4jGdsDriverFactoryInput) => fake.driver);

    await expect(
      waitForNeo4jGdsReadiness(
        { ...ENV, NEO4J_PASSWORD: ' private-password ' },
        { timeoutMs: 20, attemptTimeoutMs: 10, pollIntervalMs: 5 },
        { createDriver: factory }
      )
    ).resolves.toBe('2.6.9');
    expect(factory.mock.calls[0]?.[0].password).toBe(' private-password ');

    await expect(
      waitForNeo4jGdsReadiness(
        { ...ENV, NEO4J_PASSWORD: '   ' },
        { timeoutMs: 20, attemptTimeoutMs: 10, pollIntervalMs: 5 },
        { createDriver: factory }
      )
    ).rejects.toThrow(/NEO4J_PASSWORD is required/);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries invalid and failed probes within one bounded driver lifecycle', async () => {
    let nowMs = 0;
    const fake = fakeDriver([
      { value: '   ' },
      { error: new Error("Unknown function 'gds.version'") },
      { value: '2.6.9' },
    ]);

    await expect(
      waitForNeo4jGdsReadiness(
        ENV,
        { timeoutMs: 30, attemptTimeoutMs: 10, pollIntervalMs: 5 },
        {
          createDriver: () => fake.driver,
          now: () => nowMs,
          sleep: async (milliseconds) => {
            nowMs += milliseconds;
          },
        }
      )
    ).resolves.toBe('2.6.9');

    expect(fake.openReadSession).toHaveBeenCalledTimes(3);
    expect(fake.sessions.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('stops at the total deadline and preserves only the bounded sanitized final error', async () => {
    let nowMs = 0;
    const unsafe =
      "Failed to connect to bolt://neo4j:hunter2@10.0.0.4:7687 because password='hunter2'\nECONNREFUSED 10.0.0.4:7687";
    const fake = fakeDriver([{ error: new Error(unsafe) }, { error: new Error(unsafe) }, { error: new Error(unsafe) }]);

    const promise = waitForNeo4jGdsReadiness(
      ENV,
      { timeoutMs: 25, attemptTimeoutMs: 10, pollIntervalMs: 10 },
      {
        createDriver: () => fake.driver,
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds;
        },
      }
    );

    await expect(promise).rejects.toMatchObject({
      name: 'Neo4jGdsReadinessError',
      attempts: 3,
      lastProbeError: expect.stringContaining('ECONNREFUSED'),
    });
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Neo4jGdsReadinessError);
      const serialized = JSON.stringify(error);
      const message = (error as Error).message;
      expect(`${serialized} ${message}`).not.toContain('hunter2');
      expect(`${serialized} ${message}`).not.toContain('10.0.0.4');
      expect(message).toContain('[neo4j]');
      expect(message).toContain('[host]');
      expect(message.length).toBeLessThan(800);
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('times out a probe that never settles and still closes every resource', async () => {
    jest.useFakeTimers();
    const sessionClose = jest.fn(async () => undefined);
    const openReadSession = jest.fn((): Neo4jGdsProbeSession => ({
      probeVersion: () => new Promise<never>(() => undefined),
      close: sessionClose,
    }));
    const driverClose = jest.fn(async () => undefined);
    const driver: Neo4jGdsProbeDriver = {
      openReadSession,
      close: driverClose,
    };

    try {
      const promise = waitForNeo4jGdsReadiness(
        ENV,
        { timeoutMs: 20, attemptTimeoutMs: 5, pollIntervalMs: 1 },
        { createDriver: () => driver }
      );
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'Neo4jGdsReadinessError',
        lastProbeError: expect.stringContaining('probe exceeded'),
      });

      await jest.advanceTimersByTimeAsync(50);
      await assertion;
      expect(openReadSession.mock.calls.length).toBeGreaterThan(0);
      expect(sessionClose).toHaveBeenCalledTimes(openReadSession.mock.calls.length);
      expect(driverClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a session close that never settles within the attempt and total budgets', async () => {
    jest.useFakeTimers();
    const sessionClose = jest.fn(() => new Promise<void>(() => undefined));
    const openReadSession = jest.fn((): Neo4jGdsProbeSession => ({
      probeVersion: async () => '2.6.9',
      close: sessionClose,
    }));
    const driverClose = jest.fn(async () => undefined);
    const driver: Neo4jGdsProbeDriver = {
      openReadSession,
      close: driverClose,
    };

    try {
      const promise = waitForNeo4jGdsReadiness(
        ENV,
        { timeoutMs: 20, attemptTimeoutMs: 5, pollIntervalMs: 1 },
        { createDriver: () => driver }
      );
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'Neo4jGdsReadinessError',
        lastProbeError: expect.stringContaining('session close exceeded'),
      });

      await jest.advanceTimersByTimeAsync(50);
      await assertion;
      expect(openReadSession.mock.calls.length).toBeGreaterThan(0);
      expect(sessionClose).toHaveBeenCalledTimes(openReadSession.mock.calls.length);
      expect(driverClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a driver close that never settles after a successful probe', async () => {
    jest.useFakeTimers();
    const sessionClose = jest.fn(async () => undefined);
    const driverClose = jest.fn(() => new Promise<void>(() => undefined));
    const driver: Neo4jGdsProbeDriver = {
      openReadSession: () => ({
        probeVersion: async () => '2.6.9',
        close: sessionClose,
      }),
      close: driverClose,
    };

    try {
      const promise = waitForNeo4jGdsReadiness(
        ENV,
        { timeoutMs: 20, attemptTimeoutMs: 5, pollIntervalMs: 1 },
        { createDriver: () => driver }
      );
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'Neo4jGdsReadinessError',
        attempts: 1,
        lastProbeError: expect.stringContaining('driver close exceeded'),
      });

      await jest.advanceTimersByTimeAsync(50);
      await assertion;
      expect(sessionClose).toHaveBeenCalledTimes(1);
      expect(driverClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the probe failure when session and driver cleanup also fail', async () => {
    let nowMs = 0;
    const fake = fakeDriver(
      [
        {
          error: new Error("Unknown function 'gds.version'"),
          closeError: new Error('session close failed'),
        },
      ],
      new Error('driver close failed')
    );

    const promise = waitForNeo4jGdsReadiness(
      ENV,
      { timeoutMs: 1, attemptTimeoutMs: 1, pollIntervalMs: 1 },
      {
        createDriver: () => fake.driver,
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds;
        },
      }
    );

    await expect(promise).rejects.toMatchObject({
      lastProbeError: "Unknown function 'gds.version'",
    });
    expect(fake.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when the driver cannot close after a successful probe', async () => {
    const fake = fakeDriver([{ value: '2.6.9' }], new Error('driver close failed'));

    await expect(
      waitForNeo4jGdsReadiness(
        ENV,
        { timeoutMs: 20, attemptTimeoutMs: 10, pollIntervalMs: 5 },
        { createDriver: () => fake.driver }
      )
    ).rejects.toMatchObject({
      name: 'Neo4jGdsReadinessError',
      attempts: 1,
      lastProbeError: 'driver close failed',
    });
    expect(fake.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ...ENV, NEO4J_URI: '' }, /NEO4J_URI is required/],
    [{ ...ENV, NEO4J_PASSWORD: '' }, /NEO4J_PASSWORD is required/],
    [ENV, /timeoutMs must be a positive integer/],
  ] as const)('rejects invalid configuration before constructing a driver', async (env, message) => {
    const factory = jest.fn(() => fakeDriver([{ value: '2.6.9' }]).driver);
    const options = message.source.includes('timeoutMs')
      ? { timeoutMs: 0, attemptTimeoutMs: 1, pollIntervalMs: 1 }
      : { timeoutMs: 10, attemptTimeoutMs: 1, pollIntervalMs: 1 };

    await expect(waitForNeo4jGdsReadiness(env, options, { createDriver: factory })).rejects.toThrow(message);
    expect(factory).not.toHaveBeenCalled();
  });
});
