/** Driver registry — backend selection is configuration, not architecture. */
import { DockerDriver } from './drivers/docker.js';
import type { ExecFn, SandboxDriver, SandboxDriverName } from './types.js';

export function getDriver(name: SandboxDriverName, deps?: { exec?: ExecFn }): SandboxDriver {
  switch (name) {
    case 'docker':
      return new DockerDriver(deps);
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown sandbox driver: ${String(exhaustive)}`);
    }
  }
}
