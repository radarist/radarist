/**
 * @file lib/skill-prelude/stitch.ts
 * @description Composes per-skill sub-mission outputs into a single
 * PRECOMPUTED DISCIPLINE block and prepends it to the orchestrator's
 * user message.
 */

import { isPerEntitySkill } from './registry';
import type { SubMissionResult } from './run-sub-mission';

const HEADER =
  'PRECOMPUTED DISCIPLINE (include these blocks verbatim where they belong; do not paraphrase or wrap in additional prose):';

export function buildPreludeBlock(results: SubMissionResult[]): string {
  const successful = results.filter((r) => r.success && r.block.trim().length > 0);
  if (successful.length === 0) return '';

  const perEntity = successful.filter((r) => isPerEntitySkill(r.skill));
  const briefLevel = successful.filter((r) => !isPerEntitySkill(r.skill));

  const ordered = [...perEntity, ...briefLevel];
  const body = ordered.map((r) => r.block.trim()).join('\n\n');

  return `${HEADER}\n\n${body}\n`;
}

export function injectIntoPrompt(preludeBlock: string, originalPrompt: string): string {
  if (!preludeBlock) return originalPrompt;
  return `${preludeBlock}\n${originalPrompt}`;
}
