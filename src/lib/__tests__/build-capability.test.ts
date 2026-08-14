/**
 * @jest-environment node
 */

/**
 * @file build-capability.test.ts
 * @description Unit coverage for the BUILD-027 build-enablement flag resolver —
 * the single source of truth shared by the dispatch gate and the capability
 * endpoint.
 */

import { isBuildEnabled } from '../build-capability';

describe('isBuildEnabled', () => {
  const original = process.env.IMPULSE_BUILD_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.IMPULSE_BUILD_ENABLED;
    else process.env.IMPULSE_BUILD_ENABLED = original;
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', '  On  '])('is true for the truthy value %j', (value) => {
    process.env.IMPULSE_BUILD_ENABLED = value;
    expect(isBuildEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', '', '   ', 'enabled'])('is false for the non-truthy value %j', (value) => {
    process.env.IMPULSE_BUILD_ENABLED = value;
    expect(isBuildEnabled()).toBe(false);
  });

  it('is false when the flag is unset', () => {
    delete process.env.IMPULSE_BUILD_ENABLED;
    expect(isBuildEnabled()).toBe(false);
  });
});
