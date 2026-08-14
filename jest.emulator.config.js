const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

/**
 * Focused Firebase-emulator integration config.
 *
 * The release contracts intentionally use a nonstandard `.emulator.ts`
 * suffix, keeping live-service tests out of the normal coverage gate. The
 * `test:emulator` script owns service startup, seeding, and teardown.
 */
module.exports = createJestConfig({
  testEnvironment: 'node',
  // Real emulator transactions can exceed Jest's 5s unit-test default on a
  // cold JVM or under concurrent CAS contention. Keep the lane bounded while
  // allowing the async operation to finish before Jest tears down its clients.
  testTimeout: 30_000,
  testMatch: ['<rootDir>/tests/emulator/**/*.emulator.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^server-only$': '<rootDir>/src/lib/__tests__/helpers/server-only-shim.ts',
  },
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
});
