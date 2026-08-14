/** @jest-environment node */

import { resolveInngestFunctionProfile } from '../function-profile';

describe('resolveInngestFunctionProfile', () => {
  it.each([undefined, '', '   ', 'full'])(
    'uses the full registry for the default value %p',
    (value) => {
      expect(resolveInngestFunctionProfile(value, true)).toBe('full');
    },
  );

  it('allows the explicit interactive registry only in development', () => {
    expect(resolveInngestFunctionProfile('interactive', true)).toBe('interactive');
    expect(() => resolveInngestFunctionProfile('interactive', false)).toThrow(
      /development-only/,
    );
  });

  it.each(['scheduled', 'manual', 'Interactive', 'full,interactive'])(
    'fails closed for unsupported profile %p',
    (value) => {
      expect(() => resolveInngestFunctionProfile(value, true)).toThrow(
        /Unsupported INNGEST_FUNCTION_PROFILE/,
      );
    },
  );
});
