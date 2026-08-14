/**
 * LOCAL-013 — terminalize job-run records whose queue state did not survive.
 *
 * The launcher runs this only after it has established that the persisted
 * Inngest queue did NOT carry over from the previous runtime. When the queue
 * did carry over, prior work is still schedulable and this script must not run:
 * marking resumable work `interrupted` would replace one false state with
 * another.
 *
 * Exits non-zero on infrastructure failure so a broken recovery is visible
 * rather than silently skipped.
 */
// This is a standalone server-side CLI, not a Client Component. Register the
// same loader guard used by other production-repository seed utilities before
// importing the server-only recovery repository.
import './server-only-stub';
import './load-env-local';

import {
  MAX_RECOVERED_RUNS_PER_PASS,
  recoverInterruptedJobRuns,
} from '@/lib/inngest/interrupted-run-recovery';
import { LOCAL_RUNTIME_EPOCH_ENV, parseRuntimeEpoch } from '@/lib/inngest/runtime-epoch';
import { parseLocalRuntimeProfileArg } from './lib/local-runtime-profile';

async function main(): Promise<void> {
  const profile = parseLocalRuntimeProfileArg(process.argv.slice(2));
  const currentEpoch = parseRuntimeEpoch(process.env[LOCAL_RUNTIME_EPOCH_ENV]);
  if (!currentEpoch) {
    throw new Error(
      `${LOCAL_RUNTIME_EPOCH_ENV} is missing or malformed; refusing to recover runs ` +
        'without a runtime identity to compare against.'
    );
  }

  const report = await recoverInterruptedJobRuns(
    { currentEpoch, queueStateCarriedOver: false },
    MAX_RECOVERED_RUNS_PER_PASS
  );

  console.log(
    `[recover-job-runs] profile=${profile} scanned=${report.scanned} ` +
      `interrupted=${report.interrupted} unknownEpoch=${report.unknownEpoch} ` +
      `alreadyTerminal=${report.alreadyTerminal} truncated=${report.truncated}`
  );
  if (report.errors.length > 0) {
    console.error(`[recover-job-runs] ${report.errors.length} record(s) failed to recover`);
    for (const error of report.errors.slice(0, 10)) console.error(`  ${error}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[recover-job-runs] failed', error);
  process.exit(1);
});
