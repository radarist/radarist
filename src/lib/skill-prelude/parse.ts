/**
 * @file lib/skill-prelude/parse.ts
 * @description Extracts required skill directives from a structured mission
 * prompt's CRITICAL DIMENSIONS block. Returns null when the block is absent,
 * letting downstream code skip the prelude for non-P3 missions.
 */

import { DIRECTIVE_TO_SKILL } from './registry';

export interface ParsedDimensions {
  /** Skills explicitly marked `required` in the structured block. */
  skills: Set<string>;
  /** Skills explicitly marked `N/A` in the structured block. */
  notApplicableSkills: Set<string>;
}

const DIMENSIONS_HEADER_RE = /^CRITICAL DIMENSIONS(?:[ \t]+\(invoke matching skills(?:;[^)\r\n]*)?\))?[ \t]*:[ \t]*$/m;
const DIRECTIVE_LINE_RE = /^[\s-]*([^:]+?)\s*:\s*(required|N\/A)\b/i;

/**
 * Parse the brief's directive block.
 *
 * `extraDirectives` lets specialized callers extend the shared registry without
 * forking the `required | N/A` grammar. Output-time report procedures now live
 * in the registry itself: the prelude records them as deliberate non-dispatches
 * and the finished-artifact evaluator consumes that durable requirement.
 */
export function parseCriticalDimensions(
  prompt: string,
  extraDirectives: Readonly<Record<string, string>> = {}
): ParsedDimensions | null {
  const headerMatch = prompt.match(DIMENSIONS_HEADER_RE);
  if (!headerMatch) return null;

  const headerEnd = headerMatch.index! + headerMatch[0].length;
  const block = prompt.slice(headerEnd);

  // Block ends at the next blank line followed by a non-list line, or EOF.
  const blockEnd = block.search(/\n\s*\n[^-\s]/);
  const body = blockEnd >= 0 ? block.slice(0, blockEnd) : block;

  const skills = new Set<string>();
  const notApplicableSkills = new Set<string>();
  const directives = Object.entries({ ...DIRECTIVE_TO_SKILL, ...extraDirectives });
  for (const rawLine of body.split('\n')) {
    const m = rawLine.match(DIRECTIVE_LINE_RE);
    if (!m) continue;

    const directive = m[1].trim();
    for (const [prefix, skill] of directives) {
      if (directive.startsWith(prefix)) {
        if (m[2].toLowerCase() === 'required') {
          // Required wins over a conflicting N/A duplicate. This prevents a
          // malformed brief from suppressing work that it also requires.
          skills.add(skill);
          notApplicableSkills.delete(skill);
        } else if (!skills.has(skill)) {
          notApplicableSkills.add(skill);
        }
        break;
      }
    }
  }

  return { skills, notApplicableSkills };
}
