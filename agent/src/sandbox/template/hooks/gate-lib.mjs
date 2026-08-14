#!/usr/bin/env node
/**
 * gate-lib.mjs — shared enforcement logic behind the mission hook scripts.
 *
 * Modes (argv[2]):
 *   post-tool  PostToolUse hook: re-run every check in .impulse/checks.json
 *              whose file globs match the edited file. Exit 2 (block; stderr
 *              is fed back to the model) when any check fails.
 *   stop       Stop hook: refuse to end the session unless completed-phase
 *              artifacts exist, done-story checks pass, and STATUS.json
 *              carries either a finished mission, a fresh handoff, or a
 *              fresh QA report.
 *
 * Zero dependencies by design — it must run before any workspace install
 * exists. Exit codes: 0 = allow, 2 = block (stderr shown to the model).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const PHASES = [
  '00-inception',
  '01-brainstorm',
  '02-user-flows',
  '03-design-system',
  '04-user-stories',
  '05-architecture',
  '06-build',
  '07-self-test',
  '08-qa',
  'done',
];

/** Static artifact(s) that must exist once a phase is complete. */
const PHASE_ARTIFACTS = {
  '00-inception': ['docs/00-inception.md'],
  '01-brainstorm': ['docs/01-brainstorm.md'],
  '02-user-flows': ['docs/02-user-flows.md'],
  '03-design-system': ['docs/03-design-system.md'],
  '04-user-stories': ['docs/04-stories.md', '.impulse/checks.json'],
  '05-architecture': ['docs/05-adr.md'],
  '06-build': [], // verified via story checks, not a static file
  '07-self-test': ['docs/07-test-report.md'],
  '08-qa': ['.impulse/qa-report.json'],
};

const CHECK_TIMEOUT_MS = 120_000;
const MAX_POST_TOOL_CHECKS = 5;
const FRESHNESS_MS = 10 * 60 * 1000;

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function block(message) {
  process.stderr.write(message.trim() + '\n');
  process.exit(2);
}

/** Minimal glob → RegExp: supports **, *, ? — enough for checks.json. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function runCheck(root, check) {
  try {
    execSync(check.command, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHECK_TIMEOUT_MS,
    });
    return { id: check.id, ok: true };
  } catch (error) {
    const out = [error.stdout, error.stderr]
      .filter(Boolean)
      .map((b) => b.toString())
      .join('\n');
    const tail = out.length > 1500 ? '…' + out.slice(-1500) : out;
    return { id: check.id, ok: false, command: check.command, output: tail };
  }
}

function loadChecks(root) {
  const path = join(root, '.impulse', 'checks.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = readJson(path);
    return Array.isArray(parsed.checks) ? parsed.checks : [];
  } catch (error) {
    block(`.impulse/checks.json is not valid JSON (${error.message}). Fix it before continuing.`);
  }
}

function failureReport(failures) {
  return failures.map((f) => `✗ ${f.id}: ${f.command}\n${f.output || '(no output)'}`).join('\n\n');
}

function postTool(root, input) {
  const filePath = input?.tool_input?.file_path;
  if (!filePath) process.exit(0);
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  // Doc/contract/spike edits don't trigger acceptance checks.
  if (rel.startsWith('..') || /^(docs|\.impulse|\.claude|spikes)\//.test(rel) || rel === 'MISSION.md') {
    process.exit(0);
  }
  const checks = loadChecks(root);
  if (!checks || checks.length === 0) process.exit(0);

  const matched = checks
    .filter((c) => Array.isArray(c.files) && c.files.some((g) => globToRegExp(g).test(rel)))
    .slice(0, MAX_POST_TOOL_CHECKS);
  if (matched.length === 0) process.exit(0);

  const failures = matched.map((c) => runCheck(root, c)).filter((r) => !r.ok);
  if (failures.length > 0) {
    block(
      `Edit to ${rel} breaks ${failures.length} acceptance check(s). Fix before moving on (never weaken the check):\n\n` +
        failureReport(failures)
    );
  }
  process.exit(0);
}

function isFresh(path) {
  try {
    return Date.now() - statSync(path).mtimeMs < FRESHNESS_MS;
  } catch {
    return false;
  }
}

/**
 * Bounded stop-blocking: the gate re-blocks even when stop_hook_active is
 * set (session 0 of Phase 0 proved a single block gets ignored — the model
 * resumed feature work and the second stop sailed through). To still avoid
 * infinite loops, attempts are counted in .impulse/.stop-attempts (expires
 * after FRESHNESS_MS); after 2 re-blocks the gate gives up and allows.
 */
function makeStopGate(root) {
  const counterPath = join(root, '.impulse', '.stop-attempts');
  const readAttempts = () => {
    try {
      const parsed = readJson(counterPath);
      return Date.now() - parsed.at < FRESHNESS_MS ? parsed.n : 0;
    } catch {
      return 0;
    }
  };
  const clear = () => {
    try {
      unlinkSync(counterPath);
    } catch {
      /* never block on counter cleanup */
    }
  };
  return {
    allow() {
      clear();
      process.exit(0);
    },
    block(message) {
      const attempts = readAttempts();
      if (attempts >= 2) {
        clear();
        process.exit(0); // give up rather than loop forever
      }
      try {
        writeFileSync(counterPath, JSON.stringify({ n: attempts + 1, at: Date.now() }));
      } catch {
        /* counter is best-effort */
      }
      block(
        `${message}\n\nThis gate blocks every stop attempt until you comply (attempt ${attempts + 1} of 3). Your ONLY remaining actions this session: (1) commit all work, (2) make .impulse/STATUS.json honest, (3) stop. Do NOT resume feature work.`
      );
    },
  };
}

/** Working-tree entries that count as dirt (session logs and build noise don't). */
function dirtyTreeEntries(root) {
  const NOISE =
    /(^|\/)(session-\d+\.(jsonl|stderr\.log|exitcode)|stderr(-\d+)?\.log|node_modules\/|test-results\/|playwright-report\/|\.stop-attempts)/;
  try {
    const out = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .split('\n')
      .filter(Boolean);
    return out.filter((line) => !NOISE.test(line.slice(3)));
  } catch {
    return []; // no git in the workspace — the tree check doesn't apply
  }
}

function stop(root, _input) {
  if (existsSync(join(root, '.impulse', 'force-stop'))) process.exit(0); // supervisor escape hatch
  const gate = makeStopGate(root);

  const statusPath = join(root, '.impulse', 'STATUS.json');
  if (!existsSync(statusPath)) {
    gate.block(
      'No .impulse/STATUS.json exists. Initialize it per the mission-methodology skill before ending the session.'
    );
  }
  let status;
  try {
    status = readJson(statusPath);
  } catch (error) {
    gate.block(`.impulse/STATUS.json is not valid JSON (${error.message}). Fix it before ending the session.`);
  }
  const phaseIdx = PHASES.indexOf(status.phase);
  if (phaseIdx === -1) {
    gate.block(`.impulse/STATUS.json has unknown phase "${status.phase}". Use one of: ${PHASES.join(', ')}.`);
  }

  // 0. The working tree must be committed (session logs excluded).
  const dirty = dirtyTreeEntries(root);
  if (dirty.length > 0) {
    gate.block(
      `Cannot end session with uncommitted work (${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'}):\n${dirty
        .slice(0, 10)
        .join(
          '\n'
        )}${dirty.length > 10 ? '\n…' : ''}\nCommit everything (per-story messages where it applies) before stopping.`
    );
  }

  // 1. Artifacts of every completed phase must exist.
  const missing = [];
  for (const phase of PHASES.slice(0, phaseIdx)) {
    for (const artifact of PHASE_ARTIFACTS[phase] ?? []) {
      if (!existsSync(join(root, artifact))) missing.push(`${artifact} (phase ${phase})`);
    }
  }
  if (missing.length > 0) {
    gate.block(
      `Cannot end session: artifacts missing for completed phases:\n- ${missing.join('\n- ')}\nProduce them (or correct STATUS.phase to the truth) first.`
    );
  }

  // 2. Checks of stories marked done must pass.
  const checks = loadChecks(root) ?? [];
  const doneStories = new Set(
    (Array.isArray(status.stories) ? status.stories : []).filter((s) => s.status === 'done').map((s) => s.id)
  );
  const failures = [];
  for (const check of checks) {
    if (!doneStories.has(check.story)) continue;
    const result = runCheck(root, check);
    if (!result.ok) {
      failures.push(result);
      if (failures.length >= 3) break;
    }
  }
  if (failures.length > 0) {
    gate.block(
      `Cannot end session: stories marked done have failing checks (fix them or set the story back to in-progress):\n\n` +
        failureReport(failures)
    );
  }

  // 3. The session must end in an honest terminal state:
  //    finished mission, fresh QA report (reviewer session), or fresh handoff.
  if (status.phase === 'done') {
    let verdict = null;
    try {
      verdict = readJson(join(root, '.impulse', 'qa-report.json')).verdict;
    } catch {
      gate.block('Phase is "done" but .impulse/qa-report.json is missing or invalid.');
    }
    if (verdict !== 'PASS') {
      gate.block('Phase is "done" but qa-report.json verdict is not PASS. Run the qa-gate or correct STATUS.phase.');
    }
    gate.allow();
  }
  if (isFresh(join(root, '.impulse', 'qa-report.json'))) gate.allow();
  const handoff = status.handoff;
  if (handoff?.reason && handoff?.nextObjective && isFresh(statusPath)) gate.allow();

  gate.block(
    `Cannot end session mid-mission without a fresh handoff. Update .impulse/STATUS.json now: current phase, honest story statuses, and handoff = { "reason": …, "nextObjective": … } describing exactly where the next session picks up.`
  );
}

const mode = process.argv[2];
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const input = readStdinJson();
if (mode === 'post-tool') postTool(root, input);
else if (mode === 'stop') stop(root, input);
else block(`gate-lib.mjs: unknown mode "${mode}" (expected post-tool | stop)`);
