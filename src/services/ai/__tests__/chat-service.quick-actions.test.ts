/**
 * @file chat-service.quick-actions.test.ts
 * @description AI-002 — quick-action + welcome-message contract, table-driven
 * over EVERY AIPageType:
 *
 *   (a) every page type gets a non-generic welcome body (not the default
 *       fallback used for unknown pages);
 *   (b) every quick action produced by getQuickActionsForContext has a chat
 *       prompt in QUICK_ACTION_MESSAGES (no action without a message — the
 *       reverse of the orphan-message problem);
 *   (c) the QUICK_ACTION_MESSAGES orphan inventory is pinned: only the two
 *       known back-compat entries (prototype_ideas, status_report) may exist
 *       without a producing page type.
 *
 * The six AI-001 page types additionally get their action sets pinned; each
 * prompt corresponds to a verified CORE_AI_TOOLS capability (see the map's
 * per-entry comments in chat-service.ts).
 */

jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  getQuickActionsForContext,
  getQuickActionMessage,
  getWelcomeMessage,
  QUICK_ACTION_MESSAGES,
} from '../chat-service';
import type { AIPageType } from '@/types/ai-assistant';

// Record<AIPageType, true> forces a compile error here whenever the union
// gains a member that this suite does not cover.
const PAGE_TYPE_MAP: Record<AIPageType, true> = {
  dashboard: true,
  radar: true,
  'relations-graph': true,
  library: true,
  'entity-list': true,
  'entity-detail': true,
  signals: true,
  'signal-triage': true,
  agents: true,
  'agent-create': true,
  'agent-monitor': true,
  'agent-settings': true,
  settings: true,
  reports: true,
  artifacts: true,
  infographics: true,
  'knowledge-graph': true,
  'assessment-triage': true,
  insights: true,
};
const ALL_PAGE_TYPES = Object.keys(PAGE_TYPE_MAP) as AIPageType[];

/** Welcome body returned for the (unreachable) default branch. */
const GENERIC_WELCOME = "I'm here to help you navigate and use the Radarist platform. What would you like to explore?";

describe('getWelcomeMessage — every page type has a deliberate welcome (AI-002)', () => {
  it.each(ALL_PAGE_TYPES)('%s gets a non-generic welcome body', (pageType) => {
    const msg = getWelcomeMessage(pageType);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain(GENERIC_WELCOME);
  });
});

describe('getQuickActionsForContext — every action has a prompt mapping', () => {
  it.each(ALL_PAGE_TYPES)('%s: every produced action maps to a QUICK_ACTION_MESSAGES prompt', (pageType) => {
    for (const hasEntity of [true, false]) {
      const actions = getQuickActionsForContext(pageType, hasEntity);
      expect(actions.length).toBeGreaterThan(0); // at least the Navigate action
      const unmapped = actions
        .map((a) => a.action)
        .filter((action) => typeof QUICK_ACTION_MESSAGES[action] !== 'string' || QUICK_ACTION_MESSAGES[action] === '');
      expect(unmapped).toEqual([]);
    }
  });

  it.each(ALL_PAGE_TYPES)('%s: action ids are unique', (pageType) => {
    const ids = getQuickActionsForContext(pageType, true).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pins the action sets for the six AI-001 page types', () => {
    const byType = (pageType: AIPageType) =>
      getQuickActionsForContext(pageType, false)
        .map((a) => a.action)
        .filter((a) => a !== 'navigation_help');
    expect(byType('reports')).toEqual(['list_reports', 'draft_report']);
    expect(byType('artifacts')).toEqual(['list_missions', 'artifact_findings']);
    expect(byType('infographics')).toEqual(['generate_infographic', 'visualize_data']);
    expect(byType('knowledge-graph')).toEqual(['explain_graph', 'community_reports']);
    expect(byType('assessment-triage')).toEqual(['pending_assessments', 'approve_top_assessment']);
    expect(byType('insights')).toEqual(['proactive_insights', 'personalized_recommendations']);
  });
});

describe('QUICK_ACTION_MESSAGES — orphan inventory stays pinned', () => {
  it('only the two known back-compat orphans exist without a producing page type', () => {
    const produced = new Set<string>();
    for (const pageType of ALL_PAGE_TYPES) {
      for (const hasEntity of [true, false]) {
        for (const action of getQuickActionsForContext(pageType, hasEntity)) {
          produced.add(action.action);
        }
      }
    }
    const orphans = Object.keys(QUICK_ACTION_MESSAGES)
      .filter((action) => !produced.has(action))
      .sort();
    // prototype_ideas / status_report predate AI-002; no page type produces
    // them today but the prompts are kept for back-compat (see chat-service.ts).
    expect(orphans).toEqual(['prototype_ideas', 'status_report']);
  });
});

describe('getQuickActionMessage — entity templating and fallback', () => {
  it('templates the entity name into entity-scoped actions', () => {
    expect(getQuickActionMessage('research_entity', 'Neo4j')).toBe('Research "Neo4j"');
    expect(getQuickActionMessage('find_relations', 'Neo4j')).toBe('Find entities related to "Neo4j"');
    expect(getQuickActionMessage('summarize_entity', 'Neo4j')).toBe('Summarize "Neo4j"');
  });

  it('falls back to the static prompt without an entity', () => {
    expect(getQuickActionMessage('research_entity')).toBe('Research this entity');
    expect(getQuickActionMessage('list_reports')).toBe(QUICK_ACTION_MESSAGES['list_reports']);
  });

  it('returns undefined for unknown actions (caller falls back to the label)', () => {
    expect(getQuickActionMessage('does_not_exist')).toBeUndefined();
  });
});
