import packageJson from '../../../package.json';
import { getAppVersion } from '../app-version';

describe('getAppVersion', () => {
  it('prefers an explicit application version', () => {
    expect(getAppVersion({ APP_VERSION: '2.1.0', npm_package_version: '1.0.0' })).toBe('2.1.0');
  });

  it('uses the npm runtime version when no explicit override exists', () => {
    expect(getAppVersion({ npm_package_version: '1.2.3' })).toBe('1.2.3');
  });

  it('falls back to the compiled package version in a standalone image', () => {
    expect(getAppVersion({ APP_VERSION: '  ', npm_package_version: '' })).toBe(packageJson.version);
  });
});
