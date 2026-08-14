import { join } from 'node:path';

/**
 * Every external provider credential recognized by repository runtimes.
 * Keep this list centralized so a new zero-spend lane cannot omit an alias
 * that another provider SDK accepts.
 */
export const PROVIDER_CREDENTIAL_ENV_KEYS = Object.freeze([
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_SERVICE_ACCOUNT_KEY',
  'FIREBASE_TOKEN',
  'CLOUDSDK_CONFIG',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'SERPAPI_KEY',
  'NEWS_API_KEY',
  'GITHUB_TOKEN',
] as const);

export interface CredentialIsolationPaths {
  readonly home: string;
  readonly claudeConfig: string;
  readonly xdgConfig: string;
  readonly xdgCache: string;
  readonly xdgData: string;
  readonly xdgState: string;
  readonly cloudSdkConfig: string;
}

export function credentialIsolationPaths(root: string): CredentialIsolationPaths {
  return {
    home: join(root, 'home'),
    claudeConfig: join(root, 'claude'),
    xdgConfig: join(root, 'xdg-config'),
    xdgCache: join(root, 'xdg-cache'),
    xdgData: join(root, 'xdg-data'),
    xdgState: join(root, 'xdg-state'),
    cloudSdkConfig: join(root, 'gcloud'),
  };
}

/**
 * Blank credentials instead of deleting them. dotenv and Next.js do not
 * override a present variable, while deleting it lets `.env.local` silently
 * restore a real key. When an isolation root is supplied, local SDK/CLI auth
 * stores are hidden as well; blank environment keys alone do not block cached
 * Claude credentials.
 */
export function scrubProviderCredentialEnv(
  env: NodeJS.ProcessEnv,
  isolationRoot?: string
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of PROVIDER_CREDENTIAL_ENV_KEYS) scrubbed[key] = '';

  if (isolationRoot) {
    const paths = credentialIsolationPaths(isolationRoot);
    scrubbed.HOME = paths.home;
    scrubbed.CLAUDE_CONFIG_DIR = paths.claudeConfig;
    scrubbed.XDG_CONFIG_HOME = paths.xdgConfig;
    scrubbed.XDG_CACHE_HOME = paths.xdgCache;
    scrubbed.XDG_DATA_HOME = paths.xdgData;
    scrubbed.XDG_STATE_HOME = paths.xdgState;
    scrubbed.CLOUDSDK_CONFIG = paths.cloudSdkConfig;
  }

  return scrubbed;
}
