import {
  PROVIDER_CREDENTIAL_ENV_KEYS,
  credentialIsolationPaths,
  scrubProviderCredentialEnv,
} from '../lib/provider-credential-env';

describe('provider credential environment', () => {
  it('blanks every provider alias while preserving unrelated variables', () => {
    const seeded = Object.fromEntries(
      PROVIDER_CREDENTIAL_ENV_KEYS.map((key) => [key, `secret-${key}`])
    );
    const scrubbed = scrubProviderCredentialEnv({ ...seeded, PATH: '/usr/bin' });

    expect(scrubbed.PATH).toBe('/usr/bin');
    for (const key of PROVIDER_CREDENTIAL_ENV_KEYS) {
      expect(key in scrubbed).toBe(true);
      expect(scrubbed[key]).toBe('');
    }
  });

  it('isolates HOME, Claude, Google Cloud, and every XDG credential/cache location', () => {
    const root = '/tmp/radarist-test-credential-root';
    const paths = credentialIsolationPaths(root);
    const scrubbed = scrubProviderCredentialEnv(
      {
        HOME: '/Users/operator',
        CLAUDE_CONFIG_DIR: '/Users/operator/.claude',
        XDG_CONFIG_HOME: '/Users/operator/.config',
        XDG_CACHE_HOME: '/Users/operator/.cache',
        XDG_DATA_HOME: '/Users/operator/.local/share',
        XDG_STATE_HOME: '/Users/operator/.local/state',
        CLOUDSDK_CONFIG: '/Users/operator/.config/gcloud',
      },
      root
    );

    expect(scrubbed).toMatchObject({
      HOME: paths.home,
      CLAUDE_CONFIG_DIR: paths.claudeConfig,
      XDG_CONFIG_HOME: paths.xdgConfig,
      XDG_CACHE_HOME: paths.xdgCache,
      XDG_DATA_HOME: paths.xdgData,
      XDG_STATE_HOME: paths.xdgState,
      CLOUDSDK_CONFIG: paths.cloudSdkConfig,
    });
  });
});
