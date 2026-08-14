/**
 * Host-side runner for the machine visual gate (Task 6).
 *
 * The validator (visual-gate.mjs) is baked into every sandbox image at
 * /opt/impulse/template/scripts/visual-gate.mjs — NOT seeded into the
 * workspace volume by entrypoint.sh (which only copies skills/hooks/
 * settings.json/workspace.gitignore on first start). Invoking the script at
 * its baked image path means it is present in every container, fresh or
 * resumed, without needing an entrypoint change. The cwd is forced to the
 * workspace so the validator's relative reads (.impulse/design-brief.json,
 * src/) resolve correctly.
 */
import { buildSanitizedShellCommand } from './session.js';
import type { SandboxDriver, SandboxExecUser, SandboxRef } from './types.js';

/**
 * The baked image path the validator is COPYed to by the sandbox Dockerfile
 * (`COPY scripts /opt/impulse/template/scripts`). Exported so the wiring test
 * can prove this constant, the Dockerfile COPY target, and the on-disk source
 * file all agree — i.e. the validator really lands where runVisualGate looks.
 */
export const BAKED_VISUAL_GATE_PATH = '/opt/impulse/template/scripts/visual-gate.mjs';
export const BAKED_NODE_PATH = '/usr/local/bin/node';

/**
 * The shell snippet runVisualGate executes inside the sandbox: cd to the
 * workspace, then run the baked validator if present. Absence is an image
 * integrity failure and exits nonzero.
 *
 * Fail closed: runtime recreation always selects the current configured image,
 * so a missing validator means that image is stale or malformed. Publishing
 * without the mandatory gate would make the QA contract optional.
 *
 * Exposed (with an overridable `scriptPath`) so both branches are provable
 * against a real shell without a full sandbox: the default (no-arg) form is
 * byte-identical to the historically-inlined command. `scriptPath` must be
 * shell-safe (no spaces/quotes) — the baked path and OS temp dirs both are.
 */
export function buildVisualGateCommand(
  scriptPath: string = BAKED_VISUAL_GATE_PATH,
  nodePath: string = BAKED_NODE_PATH
): string {
  return `cd . || exit 1; S=${scriptPath}; if [ -f "$S" ]; then ${nodePath} "$S"; else echo "VISUAL GATE FAIL: validator not baked in this image" >&2; exit 1; fi`;
}

export async function runVisualGate(
  driver: SandboxDriver,
  ref: SandboxRef,
  opts?: { user?: SandboxExecUser }
): Promise<{ ok: boolean; output: string }> {
  // Non-login + the current supervisor env allowlist prevents builder-owned
  // HOME profiles or stale container secrets from influencing this trusted
  // post-build gate.
  const r = await driver.exec(ref, ['sh', '-c', buildSanitizedShellCommand(buildVisualGateCommand())], {
    timeoutMs: 60_000,
    ...opts,
  });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-1500) };
}
