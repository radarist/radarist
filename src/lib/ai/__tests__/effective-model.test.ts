/**
 * @file effective-model.test.ts
 * @description AI-029 — the model actually served must be what gets recorded.
 *
 * Two halves:
 *   1. `resolveEffectiveModel` prefers the provider's own reported model over
 *      the requested string, because a provider is free to route an alias
 *      ("-latest", a preview id) to a different concrete model.
 *   2. A frozen allow-list of hardcoded Gemini model literals in `src/`. Any
 *      NEW literal fails this test: model choice belongs in
 *      `model-config.ts` accessors, and each exception must be a deliberate,
 *      enumerated pin rather than an unnoticed drift.
 *
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { readProviderModel, resolveEffectiveModel } from '../effective-model';

describe('resolveEffectiveModel (AI-029)', () => {
  it('prefers the provider-reported model over the requested one', () => {
    expect(resolveEffectiveModel('gemini-3.1-pro-preview', 'models/gemini-3.1-pro-002')).toBe('gemini-3.1-pro-002');
  });

  it('strips the provider "models/" prefix so it matches the rate-card key space', () => {
    expect(resolveEffectiveModel('gemini-2.5-flash', 'models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('falls back to the requested model when the provider reports nothing', () => {
    expect(resolveEffectiveModel('gemini-2.5-flash', undefined)).toBe('gemini-2.5-flash');
    expect(resolveEffectiveModel('gemini-2.5-flash', '')).toBe('gemini-2.5-flash');
    expect(resolveEffectiveModel('gemini-2.5-flash', '   ')).toBe('gemini-2.5-flash');
  });

  it('ignores a non-string provider value', () => {
    expect(resolveEffectiveModel('gemini-2.5-flash', 42 as never)).toBe('gemini-2.5-flash');
  });

  it('bounds an absurdly long provider string rather than persisting it whole', () => {
    const resolved = resolveEffectiveModel('gemini-2.5-flash', 'x'.repeat(500));
    expect(resolved.length).toBeLessThanOrEqual(200);
  });
});

/**
 * Every hardcoded `gemini-*` literal in src/, with WHY it is allowed to exist.
 * Adding a literal without adding it here fails the test below on purpose.
 */
const ALLOWED_MODEL_LITERALS: Array<{ file: string; reason: string }> = [
  // DEP-010 removed the two `gemini-2.5-*` pins that used to be enumerated here
  // (src/ai/flows/research-technology-comprehensive.ts and
  // src/lib/super-graph/evaluator-vision.ts). Both models shut down 2026-10-16
  // and neither call site was env-overridable, so each now resolves through its
  // own model-config accessor (GEMINI_COMPREHENSIVE_RESEARCH_MODEL /
  // GEMINI_VISION_MODEL) and carries no literal left to enumerate.
  {
    file: 'src/lib/inngest/functions/run-agent-mission.ts',
    reason: 'Third de-facto pin: post-mission reflection on the stable flash tier.',
  },
  {
    file: 'src/lib/mission-fact-check.ts',
    reason: 'Env-overridable defaults (FACT_CHECK_MODEL / FACT_CHECK_REASONING_MODEL).',
  },
  { file: 'src/lib/mission-quality-llm.ts', reason: 'Env-overridable DEFAULT_JUDGE_MODEL for the L2 judge.' },
  { file: 'src/lib/signals/expand-signal.ts', reason: 'Caller-overridable default for signal expansion.' },
  { file: 'src/lib/mcp/servers/gemini-servers.ts', reason: 'Caller-overridable default for the MCP Gemini variants.' },
  { file: 'src/lib/ai/model-config.ts', reason: 'The accessor defaults themselves — the canonical home.' },
  { file: 'src/lib/ai/client.ts', reason: 'The GeminiModel union declaration and JSDoc examples.' },
  { file: 'src/lib/ai/reliability.ts', reason: 'The MODEL_PRICING rate-card keys.' },
  // Type declarations and documentation — no runtime model is chosen here,
  // but they are enumerated so a union that outlives a retired model shows up.
  { file: 'src/lib/inngest/client.ts', reason: 'Type union on a mission event payload, not a runtime choice.' },
  { file: 'src/lib/types/agents.ts', reason: 'Type union on the agent config shape, not a runtime choice.' },
  { file: 'src/lib/schemas/agent-run.ts', reason: 'JSDoc example of the model field format, not a runtime choice.' },
];

describe('hardcoded Gemini model literals are enumerated (AI-029)', () => {
  it('has no unenumerated hardcoded model literal in src/', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    let output = '';
    try {
      output = execFileSync('grep', ['-rlE', '[\'"]gemini-[0-9]', 'src', '--include=*.ts', '--include=*.tsx'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch (error) {
      // grep exits 1 when nothing matches — that's a legitimate empty result.
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }

    const found = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !file.includes('__tests__') && !file.includes('.test.'));

    const allowed = new Set(ALLOWED_MODEL_LITERALS.map((entry) => entry.file));
    const unexpected = found.filter((file) => !allowed.has(file));

    expect(unexpected).toEqual([]);
  });

  it('every enumerated exception still carries a stated reason', () => {
    for (const entry of ALLOWED_MODEL_LITERALS) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('readProviderModel (AI-029)', () => {
  it('returns undefined when the provider reported nothing usable', () => {
    expect(readProviderModel(undefined)).toBeUndefined();
    expect(readProviderModel('')).toBeUndefined();
    expect(readProviderModel('   ')).toBeUndefined();
    expect(readProviderModel(7 as never)).toBeUndefined();
  });

  it('normalizes a reported model to the rate-card key space', () => {
    expect(readProviderModel('models/gemini-3.1-pro-002')).toBe('gemini-3.1-pro-002');
  });
});

/**
 * Guards the failure this whole change exists to prevent: a value that is
 * computed, exposed, and then never actually written anywhere (the
 * recorded-but-never-read gap). If the chat route stops threading the served
 * model into its AgentRun, this fails.
 */
describe('the served model reaches persistence (AI-029)', () => {
  const chatRouteSource = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../../app/api/ai/chat/route.ts'),
    'utf8'
  );

  it('the chat route reads the provider-reported model', () => {
    // The provider accessor is intentionally isolated behind a try/catch: some
    // SDK response getters can throw. Keep both halves of that fail-closed
    // handoff wired rather than requiring the older direct-call spelling.
    expect(chatRouteSource).toContain('rawServedModel = response.response.modelVersion');
    expect(chatRouteSource).toContain('readProviderModel(rawServedModel)');
  });

  it('the chat AgentRun records the served model, not the requested one', () => {
    expect(chatRouteSource).toContain('const effectiveModel = geminiUsage.effectiveModel ?? model');
    expect(chatRouteSource).toContain('model: effectiveModel');
  });
});
