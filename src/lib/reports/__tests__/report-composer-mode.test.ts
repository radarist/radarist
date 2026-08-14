/**
 * @jest-environment node
 */

import { isReportComposerEnabled } from '../report-composer-mode';

describe('isReportComposerEnabled', () => {
  it.each([
    [{}, false],
    [{ REPORT_COMPOSER_MODE: '' }, false],
    [{ REPORT_COMPOSER_MODE: 'legacy' }, false],
    [{ REPORT_COMPOSER_MODE: 'Template' }, false],
    [{ REPORT_COMPOSER_MODE: 'template' }, true],
  ] as const)('resolves the exact opt-in contract for %p', (env, expected) => {
    expect(isReportComposerEnabled(env)).toBe(expected);
  });
});
