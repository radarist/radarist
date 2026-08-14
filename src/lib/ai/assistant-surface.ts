/**
 * @file lib/ai/assistant-surface.ts
 * @description Pure assistant-surface contract (AI-006): per-page-type quick
 * actions, their chat prompts, their backing CORE tools, and the welcome
 * messages.
 *
 * Extracted from `src/services/ai/chat-service.ts` (which re-exports
 * everything here, so existing imports keep working) because the
 * capability-catalog generator renders this contract into
 * docs/CAPABILITIES.md and must import it WITHOUT dragging in
 * `fetch-with-auth` → the Firebase client SDK. No imports beyond types — this
 * module stays importable from scripts, tests, client and server alike.
 */

import type { AIPageType, AIQuickAction } from '@/types/ai-assistant';

// ============================================================================
// Page-Type Inventory
// ============================================================================

/**
 * Runtime list of every AIPageType. The Record type forces a compile error
 * here whenever the union gains a member, so the generator's "Assistant
 * surface" section and the quick-action tests can never silently lag the type.
 */
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

export const ALL_AI_PAGE_TYPES = Object.keys(PAGE_TYPE_MAP) as AIPageType[];

// ============================================================================
// Quick Actions
// ============================================================================

/**
 * Returns quick actions based on the current context.
 */
export function getQuickActionsForContext(pageType: AIPageType, hasEntity: boolean): AIQuickAction[] {
  const actions: AIQuickAction[] = [];

  switch (pageType) {
    case 'dashboard':
      actions.push(
        {
          id: 'show-metrics',
          label: 'Show Metrics',
          icon: 'BarChart3',
          action: 'show_metrics',
        },
        {
          id: 'recent-activity',
          label: 'Recent Activity',
          icon: 'Activity',
          action: 'recent_activity',
        }
      );
      break;

    case 'radar':
      actions.push(
        {
          id: 'analyze-trends',
          label: 'Analyze Trends',
          icon: 'TrendingUp',
          action: 'analyze_trends',
        },
        {
          id: 'suggest-entries',
          label: 'Suggest Entries',
          icon: 'Lightbulb',
          action: 'suggest_entries',
        }
      );
      break;

    case 'entity-detail':
      if (hasEntity) {
        actions.push(
          {
            id: 'research',
            label: 'Research',
            icon: 'Search',
            action: 'research_entity',
          },
          {
            id: 'find-relations',
            label: 'Find Relations',
            icon: 'GitBranch',
            action: 'find_relations',
          },
          {
            id: 'summarize',
            label: 'Summarize',
            icon: 'FileText',
            action: 'summarize_entity',
          }
        );
      }
      break;

    case 'entity-list':
    case 'library':
      actions.push(
        {
          id: 'filter-help',
          label: 'Filter Help',
          icon: 'Filter',
          action: 'filter_help',
        },
        {
          id: 'bulk-actions',
          label: 'Bulk Actions',
          icon: 'Layers',
          action: 'bulk_actions',
        }
      );
      break;

    case 'signals':
    case 'signal-triage':
      actions.push(
        {
          id: 'explain-signals',
          label: 'Explain Signals',
          icon: 'HelpCircle',
          action: 'explain_signals',
        },
        {
          id: 'bulk-approve',
          label: 'Approve High',
          icon: 'CheckCircle',
          action: 'bulk_approve',
        }
      );
      break;

    case 'relations-graph':
      actions.push(
        {
          id: 'explain-graph',
          label: 'Explain Graph',
          icon: 'Network',
          action: 'explain_graph',
        },
        {
          id: 'find-clusters',
          label: 'Find Clusters',
          icon: 'Circle',
          action: 'find_clusters',
        }
      );
      break;

    case 'agents':
      actions.push(
        {
          id: 'agent-help',
          label: 'Agent Help',
          icon: 'Bot',
          action: 'agent_help',
        },
        {
          id: 'create-agent',
          label: 'Create Agent',
          icon: 'Plus',
          action: 'create_agent',
        }
      );
      break;

    case 'agent-create':
      actions.push(
        {
          id: 'wizard-help',
          label: 'Wizard Help',
          icon: 'HelpCircle',
          action: 'wizard_help',
        },
        {
          id: 'task-suggestions',
          label: 'Task Ideas',
          icon: 'Lightbulb',
          action: 'task_suggestions',
        }
      );
      break;

    case 'agent-monitor':
      actions.push(
        {
          id: 'agent-status',
          label: 'Agent Status',
          icon: 'Activity',
          action: 'agent_status',
        },
        {
          id: 'troubleshoot',
          label: 'Troubleshoot',
          icon: 'Wrench',
          action: 'troubleshoot_agent',
        }
      );
      break;

    case 'agent-settings':
      actions.push({
        id: 'config-help',
        label: 'Config Help',
        icon: 'Settings',
        action: 'config_help',
      });
      break;

    case 'settings':
      actions.push({
        id: 'settings-help',
        label: 'Settings Help',
        icon: 'Settings',
        action: 'settings_help',
      });
      break;

    // AI-002 — quick actions for the page types added in AI-001. Every action's
    // chat prompt (QUICK_ACTION_MESSAGES below) maps to a verified CORE_AI_TOOLS
    // capability; the backing tools are pinned in QUICK_ACTION_TOOLS.
    case 'reports':
      actions.push(
        {
          id: 'list-reports',
          label: 'List Reports',
          icon: 'FileText',
          action: 'list_reports',
        },
        {
          id: 'draft-report',
          label: 'Draft Report',
          icon: 'Plus',
          action: 'draft_report',
        }
      );
      break;

    case 'artifacts':
      actions.push(
        {
          id: 'list-missions',
          label: 'Recent Missions',
          icon: 'Rocket',
          action: 'list_missions',
        },
        {
          id: 'artifact-findings',
          label: 'Latest Findings',
          icon: 'ClipboardList',
          action: 'artifact_findings',
        }
      );
      break;

    case 'infographics':
      actions.push(
        {
          id: 'generate-infographic',
          label: 'New Infographic',
          icon: 'Sparkles',
          action: 'generate_infographic',
        },
        {
          id: 'visualize-data',
          label: 'Visualize Data',
          icon: 'BarChart3',
          action: 'visualize_data',
        }
      );
      break;

    case 'knowledge-graph':
      actions.push(
        {
          id: 'explain-graph',
          label: 'Explain Graph',
          icon: 'Network',
          action: 'explain_graph',
        },
        {
          id: 'community-reports',
          label: 'Communities',
          icon: 'Layers',
          action: 'community_reports',
        }
      );
      break;

    case 'assessment-triage':
      actions.push(
        {
          id: 'pending-assessments',
          label: 'Pending Items',
          icon: 'ClipboardList',
          action: 'pending_assessments',
        },
        {
          id: 'approve-top-assessment',
          label: 'Approve Top',
          icon: 'CheckCircle',
          action: 'approve_top_assessment',
        }
      );
      break;

    case 'insights':
      actions.push(
        {
          id: 'my-insights',
          label: 'My Insights',
          icon: 'Lightbulb',
          action: 'proactive_insights',
        },
        {
          id: 'recommendations',
          label: 'What Next',
          icon: 'TrendingUp',
          action: 'personalized_recommendations',
        }
      );
      break;
  }

  // Always add general actions
  actions.push({
    id: 'navigation-help',
    label: 'Navigate',
    icon: 'Compass',
    action: 'navigation_help',
  });

  return actions;
}

// ============================================================================
// Quick Action → Chat Prompt Mapping
// ============================================================================

/**
 * Chat prompt sent when a quick action is clicked (AIChat submits these as
 * plain chat messages). Relocated here from AIChat.tsx (AI-002) so the
 * action→prompt contract is unit-testable without rendering the chat UI.
 *
 * Every prompt must correspond to an executable CORE_AI_TOOLS capability
 * (src/lib/ai/tools.ts) or a navigation request — the backing tools for the
 * AI-002 additions are pinned in QUICK_ACTION_TOOLS below and cross-checked
 * against CORE_AI_TOOLS in quick-action-tools-contract.test.ts.
 */
export const QUICK_ACTION_MESSAGES: Record<string, string> = {
  show_metrics: 'Show me the current dashboard metrics',
  recent_activity: "What's the recent activity in the platform?",
  analyze_trends: 'Analyze the current technology trends on the radar',
  suggest_entries: 'Suggest new entries for the radar',
  // Entity actions — these are the entity-less fallbacks; getQuickActionMessage
  // templates the entity name in when one is in context.
  research_entity: 'Research this entity',
  find_relations: 'Find related entities',
  summarize_entity: 'Summarize this entity',
  filter_help: 'How can I filter the items in this list?',
  bulk_actions: 'What bulk actions can I perform here?',
  explain_signals: 'Explain the current signals in the triage queue',
  bulk_approve: 'Approve all high-confidence signals',
  explain_graph: 'Explain the relationships shown in this graph',
  find_clusters: 'Find clusters of related entities in the graph',
  // Known orphans (kept for back-compat): no page type produces these actions
  // today — see the quick-actions contract test, which pins this inventory.
  prototype_ideas: 'Suggest new prototype ideas based on current technologies',
  status_report: 'Give me a status report on current prototypes',
  agent_help: 'How do AI agents work in this platform?',
  create_agent: 'Help me create a new AI agent',
  // Previously unmapped actions (fell back to the button label as the chat
  // message) — mapped so every produced action has a deliberate prompt.
  wizard_help: 'Help me use the agent creation wizard',
  task_suggestions: 'Suggest task ideas for a new agent',
  agent_status: 'What is the current status of my agents?',
  troubleshoot_agent: 'Help me troubleshoot an agent issue',
  config_help: 'Explain the agent configuration options',
  settings_help: 'Explain the available settings',
  navigation_help: 'Help me navigate the platform',
  // AI-002 additions — backing CORE_AI_TOOLS capabilities in QUICK_ACTION_TOOLS.
  list_reports: 'List my recent reports',
  draft_report: 'Draft a new report summarizing recent findings',
  list_missions: 'Show my recent agent missions and their artifacts',
  artifact_findings: 'What did my recent evaluation artifacts find?',
  generate_infographic: 'Generate a new infographic from my radar data',
  visualize_data: 'Create a data visualization from my current data',
  community_reports: 'Summarize the communities in the knowledge graph',
  pending_assessments: 'What assessments are pending my review?',
  approve_top_assessment: 'Approve the top pending assessment',
  proactive_insights: 'What proactive insights do you have for me?',
  personalized_recommendations: 'What should I look at next based on my radar?',
};

/**
 * AI-006 — backing CORE_AI_TOOLS capability per quick action, from the AI-002
 * verified table (formerly inline comments next to QUICK_ACTION_MESSAGES).
 * Actions absent from this map (navigation/guidance actions like
 * `navigation_help` or `filter_help`) are answered conversationally and have
 * no single backing tool by design.
 *
 * CONTRACT (enforced by src/lib/ai/__tests__/quick-action-tools-contract.test.ts):
 * every tool name listed here must exist in CORE_AI_TOOLS, and every key must
 * be a known QUICK_ACTION_MESSAGES action. The capability-catalog generator
 * renders this map into docs/CAPABILITIES.md ("Assistant surface").
 */
export const QUICK_ACTION_TOOLS: Record<string, string[]> = {
  list_reports: ['listReports', 'getReportById'],
  // Interactive chat cannot use mission-bound draftReport/publishReport.
  // Gather recent findings, then stage the paid creator mission honestly.
  draft_report: ['getArtifactFindings', 'startMission'],
  list_missions: ['listUserMissions', 'getMissionStatus'],
  artifact_findings: ['getArtifactFindings'],
  generate_infographic: ['listRadars', 'getRadarDetails', 'generateInfographic'],
  visualize_data: ['listRadars', 'getRadarDetails', 'generateVisualization'],
  community_reports: ['getCommunityReports', 'listCommunityClusters'],
  pending_assessments: ['getPendingProposals'],
  approve_top_assessment: ['getPendingProposals', 'approveAssessment'],
  proactive_insights: ['getProactiveInsights'],
  personalized_recommendations: ['listRadars', 'getRadarDetails', 'getPersonalizedRecommendations'],
};

/**
 * Resolves the chat prompt for a quick action, templating the in-context
 * entity name into the entity-scoped actions when one is available.
 *
 * @returns The prompt, or `undefined` for an unknown action id (callers fall
 * back to the action's label).
 */
export function getQuickActionMessage(action: string, entityName?: string): string | undefined {
  if (entityName) {
    switch (action) {
      case 'research_entity':
        return `Research "${entityName}"`;
      case 'find_relations':
        return `Find entities related to "${entityName}"`;
      case 'summarize_entity':
        return `Summarize "${entityName}"`;
      default:
        break;
    }
  }
  return QUICK_ACTION_MESSAGES[action];
}

// ============================================================================
// Welcome Messages
// ============================================================================

/**
 * Explicit AI-interaction disclosure (EU AI Act Art 50(1)) prepended to the
 * welcome message so every chat session opens by telling the user, in plain
 * text, that they are talking to an AI.
 */
const AI_INTERACTION_NOTICE =
  "You're chatting with an AI assistant — it can make mistakes, so please review its suggestions before acting on them.";

/**
 * Returns a context-aware welcome message, prefixed with the AI-interaction notice.
 */
export function getWelcomeMessage(pageType: AIPageType, entityName?: string): string {
  return `${AI_INTERACTION_NOTICE}\n\n${getWelcomeBody(pageType, entityName)}`;
}

function getWelcomeBody(pageType: AIPageType, entityName?: string): string {
  switch (pageType) {
    case 'dashboard':
      return 'Welcome! I can help you navigate the platform, understand metrics, or find specific information. What would you like to explore?';

    case 'radar':
      return 'I can help you analyze the technology radar, identify trends, or suggest new entries. What would you like to know?';

    case 'entity-detail':
      return entityName
        ? `I can help you learn more about "${entityName}", find related entities, or suggest improvements. What would you like to explore?`
        : 'I can help you understand this entity, find relationships, or provide research insights.';

    case 'entity-list':
    case 'library':
      return 'I can help you filter and find specific entities, understand patterns, or perform bulk operations. How can I assist?';

    case 'signals':
    case 'signal-triage':
      return 'I can explain signals, help with triage decisions, or identify patterns. What would you like to know?';

    case 'relations-graph':
      return 'I can help you understand entity relationships, identify clusters, or find connection paths. What interests you?';

    case 'agents':
      return 'I can help you create and configure AI agents, understand their capabilities, or troubleshoot issues.';

    case 'agent-create':
      return 'I can help you choose the right task template, configure your agent, or suggest optimal settings. What would you like to build?';

    case 'agent-monitor':
      return 'I can help you understand agent status, analyze performance, or troubleshoot issues. What would you like to know?';

    case 'agent-settings':
      return 'I can explain agent configuration options or help you optimize settings. What would you like to adjust?';

    case 'settings':
      return 'I can explain settings options or help you configure the platform. What would you like to adjust?';

    case 'reports':
      return 'I can list your generated reports, dig into their findings, or draft a new one. What would you like to see?';

    case 'artifacts':
      return 'I can show your build and evaluation artifacts, summarize what recent missions produced, or surface the most interesting findings.';

    case 'infographics':
      return 'I can generate new infographics from your data or help you find existing visualizations. What should we create?';

    case 'knowledge-graph':
      return 'I can explain what the knowledge graph shows, summarize its communities, or trace connections between entities. Where should we start?';

    case 'assessment-triage':
      return 'I can walk you through pending assessments, explain evaluation verdicts, or approve items for you. What would you like to review?';

    case 'insights':
      return 'I can surface the proactive insights your agents noticed, explain why they matter, or recommend what to look at next.';

    default:
      return "I'm here to help you navigate and use the Radarist platform. What would you like to explore?";
  }
}
