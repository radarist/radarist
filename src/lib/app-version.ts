import packageJson from '../../package.json';

type VersionEnvironment = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function getAppVersion(env: VersionEnvironment = process.env): string {
  return nonEmpty(env.APP_VERSION) ?? nonEmpty(env.npm_package_version) ?? packageJson.version;
}
