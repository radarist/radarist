export interface EmulatorHostPort {
  host: string;
  port: number;
}

export const DEFAULT_FIREBASE_EMULATOR_HOSTS = {
  firestore: '127.0.0.1:8080',
  auth: '127.0.0.1:9099',
  storage: '127.0.0.1:9199',
} as const;

function parseWithUrl(value: string): URL {
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
}

export function parseEmulatorHost(value: string | undefined, fallback: string): EmulatorHostPort {
  const fallbackUrl = parseWithUrl(fallback);
  const raw = value?.trim() || fallback;

  try {
    const parsed = parseWithUrl(raw);
    const port = Number(parsed.port || fallbackUrl.port);
    if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid emulator host: ${raw}`);
    }
    return { host: parsed.hostname, port };
  } catch {
    return {
      host: fallbackUrl.hostname,
      port: Number(fallbackUrl.port),
    };
  }
}

export function formatHostPort(hostPort: EmulatorHostPort): string {
  return `${hostPort.host}:${hostPort.port}`;
}

export function formatEmulatorOrigin(value: string | undefined, fallback: string): string {
  const hostPort = parseEmulatorHost(value, fallback);
  return `http://${formatHostPort(hostPort)}`;
}
