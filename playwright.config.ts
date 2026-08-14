import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { laneById, loadPublicE2ERuntimeManifest, specsOutsideLanePatterns } from './scripts/lib/e2e-runtime-manifest';
import { scrubProviderCredentialEnv } from './scripts/lib/provider-credential-env';

const selectedRuntimeLane = process.env.E2E_RUNTIME_LANE;
if (!selectedRuntimeLane) throw new Error('E2E_RUNTIME_LANE is required');
const runtimeManifest = loadPublicE2ERuntimeManifest(__dirname);
const selectedLane = laneById(runtimeManifest, selectedRuntimeLane);
Object.assign(process.env, scrubProviderCredentialEnv(process.env), {
  CLAUDE_CHAT_ENABLED: 'false', DEFENSE_MINISTER_ENABLED: 'false', INNGEST_ENABLED: 'false',
  MAINTENANCE_PAUSED: 'true', NEXT_PUBLIC_INNGEST_ENABLED: 'false',
});
dotenv.config({ path: path.resolve(__dirname, '.env.local') });
const requiresServer = ['generic', 'accessibility'].includes(selectedRuntimeLane);
const requiresSetup = requiresServer;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/deferred/**', ...specsOutsideLanePatterns(runtimeManifest, selectedRuntimeLane)],
  fullyParallel: false, forbidOnly: !!process.env.CI, retries: process.env.CI ? 2 : 0, workers: 1,
  reporter: [['html']],
  use: { baseURL: 'http://127.0.0.1:9002', trace: 'on-first-retry', screenshot: 'only-on-failure', actionTimeout: 30_000, navigationTimeout: 30_000 },
  projects: requiresSetup
    ? [{ name: 'setup', testMatch: /auth\.setup\.ts/ }, { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] }]
    : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(requiresServer ? { webServer: { command: 'npm run e2e:serve', url: 'http://127.0.0.1:9002', reuseExistingServer: false, timeout: 300_000 } } : {}),
});
void selectedLane;
