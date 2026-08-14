const nextJest = require('next/jest');
const createJestConfig = nextJest({ dir: './' });
module.exports = createJestConfig({
  setupFiles: ['<rootDir>/jest.pre-setup.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: '<rootDir>/jest.environment.js',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1', '^nanoid$': '<rootDir>/node_modules/nanoid/index.cjs', '^server-only$': '<rootDir>/src/lib/__tests__/helpers/server-only-shim.ts' },
  transformIgnorePatterns: ['node_modules/(?!(nanoid)/)'],
  modulePathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/private/'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx', '**/tests/**/*.test.ts', '**/tests/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/', '/.next/', '/tests/e2e/', '/tests/performance/', '.*performance\.test\.ts$', '<rootDir>/agent/', '<rootDir>/private/'],
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!src/**/*.d.ts', '!src/**/*.stories.{js,jsx,ts,tsx}', '!src/**/__tests__/**'],
  coverageThreshold: { global: { statements: 52, branches: 41, functions: 44, lines: 52 } },
  coverageReporters: ['json', 'lcov', 'text', 'clover', 'json-summary'],
});
