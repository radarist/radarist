/**
 * @file audit-harness-failsafe.spec.ts
 * @description TEST-011 integration proof: in a REAL browser, an audited context
 * with an enforced short timeout fails a hang on a perpetually-disabled control
 * PROMPTLY (not the 20-minute ceiling that the pre-release entity audit hit), and
 * the AuditRecorder's on-disk checkpoint still holds every completed step plus the
 * failed step — evidence is not lost.
 *
 * Deliberately self-contained: it uses `page.setContent` (no baseURL, no seeded
 * data, no emulator), so it proves the harness behaviour without the app stack.
 * The fine-grained invariants (atomic checkpointing without stop(), bounded
 * screenshots, exact-owned cleanup, run-id safety) are unit-proven in
 * tests/harness/__tests__/audit-recorder.test.ts.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditRecorder, readAuditCheckpoint } from '../harness/audit-recorder';
import { newAuditedContext } from '../harness/audited-context';

const DISABLED_BUTTON_PAGE = `<!doctype html><meta charset="utf-8"><title>audit-failsafe</title>
<button id="save" disabled>Save</button>`;

test.describe('TEST-011 — live-audit harness fails promptly without losing evidence', () => {
  // Safety net well under the historical 20-minute ceiling: if the context
  // timeout regressed, this fails here instead of hanging the whole suite.
  test.setTimeout(60_000);

  test('an enforced context timeout fast-fails a disabled-button hang; evidence survives', async ({ browser }) => {
    const root = mkdtempSync(join(tmpdir(), 'audit-failsafe-'));
    const context = await newAuditedContext(browser, {
      actionTimeoutMs: 2_000,
      navigationTimeoutMs: 2_000,
    });
    const rec = new AuditRecorder({ runId: 'failsafe-proof', outputRoot: root });

    try {
      const page = await context.newPage();

      rec.startStep('render page');
      await page.setContent(DISABLED_BUTTON_PAGE);
      rec.passStep();

      rec.startStep('confirm save button is present but disabled');
      await expect(page.locator('#save')).toBeDisabled();
      rec.passStep();

      // The hang: click waits for the button to become enabled, which never
      // happens. With the enforced 2s context timeout this rejects in ~2s.
      rec.startStep('click disabled save (induced hang)');
      const startedAt = Date.now();
      let timedOut = false;
      try {
        await page.click('#save');
      } catch (err) {
        timedOut = true;
        rec.failStep(err);
      }
      const elapsedMs = Date.now() - startedAt;

      // 1. It failed, and it failed PROMPTLY (nowhere near the 20-min ceiling).
      expect(timedOut).toBe(true);
      expect(elapsedMs).toBeLessThan(15_000);

      // 2. Structured evidence for every step is durable on disk.
      const cp = readAuditCheckpoint(rec.dir);
      expect(cp.steps.map((s) => [s.name, s.status])).toEqual([
        ['render page', 'passed'],
        ['confirm save button is present but disabled', 'passed'],
        ['click disabled save (induced hang)', 'failed'],
      ]);
      expect(cp.steps[2].error).toBeTruthy();
    } finally {
      rec.cleanup();
      await context.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
