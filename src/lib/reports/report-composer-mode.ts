import 'server-only';

/**
 * The structured report composer is opt-in until its release acceptance is
 * complete. Only the exact documented value enables it; unset, empty, and
 * misspelled values all retain the proven legacy HTML path.
 */
export function isReportComposerEnabled(
  env?: Readonly<{ REPORT_COMPOSER_MODE?: string }>
): boolean {
  const mode = env === undefined ? process.env.REPORT_COMPOSER_MODE : env.REPORT_COMPOSER_MODE;
  return mode === 'template';
}
