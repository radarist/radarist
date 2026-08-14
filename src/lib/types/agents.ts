// ============================================================================
// AGENT & SYSTEM CONFIGURATION TYPES
// ============================================================================
// Agent activity, custom agents, agent runs, episodes, system configuration,
// signal detection config, linker agent config, and notification config.

// ============================================================================
// AGENT ACTIVITY TYPES
// ============================================================================

/**
 * Type of agent that performed an action.
 * Part of the multi-agent architecture.
 */
export type AgentType =
  | 'InnovationAgent' // Main conversational agent
  | 'ScoutAgent' // External signal detection
  | 'EvaluationAgent' // Technology scoring and alignment
  | 'PortfolioAgent' // Roadmap and resource allocation
  | 'MonitorAgent' // Technology maturity tracking
  | 'PrototypeAgent' // Prototype brief generation
  | 'LinkerAgent'; // Automatic relation discovery

/**
 * Type of activity performed by an agent.
 */
export type AgentActivityType =
  | 'discovery' // Discovered new tech/company/signal
  | 'update' // Updated existing entity
  | 'research' // Performed deep research
  | 'suggestion' // Made a suggestion to user
  | 'alert' // Alert about important change
  | 'automation'; // Automated action (e.g., auto-imported signal)

/**
 * Status of an agent activity.
 */
export type AgentActivityStatus =
  | 'completed' // Action completed successfully
  | 'pending' // Action pending (e.g., awaiting user review)
  | 'failed' // Action failed
  | 'needs_review'; // Action needs human review before completion

/**
 * Priority level of an activity.
 */
export type AgentActivityPriority = 'high' | 'medium' | 'low';

/**
 * Represents an action performed by an AI agent.
 * Displayed in the Dashboard's "AI Agent Feed" for transparency.
 *
 * **Purpose:**
 * - Provide visibility into autonomous agent actions
 * - Track what agents are discovering, updating, and suggesting
 * - Enable human oversight and intervention
 * - Build trust through transparency
 *
 * **Example Activities:**
 * - ScoutAgent discovered 5 new technologies (3 auto-imported)
 * - EvaluationAgent updated strategic alignment scores
 * - MonitorAgent detected maturity change in "Quantum Sensors"
 * - PrototypeAgent generated project brief for "AI Flavor Lab"
 */
export interface AgentActivity {
  /** Unique identifier for the activity */
  id: string;

  /** Type of activity */
  type: AgentActivityType;

  /** Activity title (short description) */
  title: string;

  /** Detailed description of what the agent did */
  description: string;

  /** Agent that performed the action */
  agent: AgentType;

  /** Current status of the activity */
  status: AgentActivityStatus;

  /** Priority level (affects display order in feed) */
  priority: AgentActivityPriority;

  /**
   * Related entities affected by this activity.
   * Used for filtering and navigation.
   */
  relatedEntities: {
    technologies?: string[]; // Format: "radarId:entryId"
    companies?: string[];
    useCases?: string[];
    prototypes?: string[];
    strategies?: string[];
    signals?: string[];
  };

  /**
   * Action taken by the agent (optional).
   * Structured data about what specifically was done.
   */
  actionTaken?: {
    type: string; // e.g., "add_technology", "update_score", "send_alert"
    data: Record<string, unknown>; // Action-specific data
  };

  /** User ID who needs to review this activity (if applicable) */
  assignedTo?: string;

  /**
   * Resolution data (if activity required human review).
   * Records the user's decision and any notes.
   */
  resolution?: {
    /** User's decision */
    action: 'approved' | 'rejected' | 'modified';
    /** User ID who resolved */
    by: string;
    /** When resolved (milliseconds since epoch) */
    at: number;
    /** User notes (optional) */
    notes?: string;
  };

  /** Timestamp when activity was created (milliseconds since epoch) */
  createdAt: number;

  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;
}

// ============================================================================
// SYSTEM CONFIGURATION TYPES
// ============================================================================

/**
 * Agent operation mode.
 * Determines how much autonomy agents have.
 */
export type AgentMode = 'autopilot' | 'copilot';

/**
 * Configuration for agent behavior (autopilot vs co-pilot mode).
 */
export interface AgentModeConfig {
  /** Main operation mode */
  mode: AgentMode;

  /**
   * Confidence threshold for automatic actions (0-100%).
   * Only applies in autopilot mode.
   * Actions with confidence >= this threshold are executed automatically.
   * Default: 90
   */
  autoActionThreshold: number;

  /** Enable automatic addition of technologies (applies only in autopilot mode) */
  autoAddTechnologies: boolean;

  /** Enable automatic updates to technology maturity (applies only in autopilot mode) */
  autoUpdateMaturity: boolean;

  /** Enable automatic linking of relationships between entities */
  autoLinkRelationships: boolean;

  /** Enable automatic import of high-confidence signals */
  autoImportSignals: boolean;
}

/**
 * Configuration for external signal detection.
 */
export interface SignalDetectionConfig {
  /** Master enable/disable for signal monitoring */
  enabled: boolean;

  /**
   * Minimum relevance score to capture a signal (0-100%).
   * Signals below this threshold are discarded.
   * Default: 50
   */
  minRelevanceScore: number;

  /** Which external sources to monitor */
  sources: {
    patents: boolean; // Google Patents, USPTO
    papers: boolean; // arXiv, PubMed, IEEE
    news: boolean; // NewsAPI, RSS feeds
    funding: boolean; // Crunchbase, PitchBook
    github: boolean; // GitHub trending
    trends: boolean; // Google Trends
    hackernews?: boolean; // Hacker News (Algolia) — optional: persisted configs predate this field
    sec?: boolean; // SEC EDGAR (opt-in)
  };

}

/**
 * Release configuration for the scheduled Linker. Cadence, candidate limits,
 * verification thresholds, and review policy are server-owned in v0.1.
 */
export interface LinkerAgentConfig {
  /** Capability gate beneath the background-automation master. */
  enabled: boolean;
}

/**
 * Configuration for release-safe background automation.
 * Persisted on the singleton system-config document and read live by
 * scheduled signal, linker, discovery, and impulse producers.
 */
export interface SweepConfig {
  /** Master enable/disable for background automation. Missing means paused. */
  enabled: boolean;

  /**
   * Maximum actions (missions + verifications) the sweep may plan per cycle.
   * Acts as an upper bound alongside the `SWEEP_MAX_MISSIONS_PER_CYCLE` env
   * cap — the lower of the two wins. Range: 1-20. Default: 10.
   */
  maxActionsPerSweep: number;
}

/**
 * Configuration for user notifications.
 */
export interface NotificationConfig {
  /** Enable email notifications (future feature) */
  email: boolean;

  /** Enable dashboard notifications (always true) */
  dashboard: boolean;

  /** Slack webhook URL for notifications (optional, future feature) */
  slack?: string;
}

/**
 * Global system configuration.
 * Singleton entity (only one config exists with id="global").
 * Controls agent behavior, signal detection, and notifications.
 *
 * **Usage:**
 * - Configured via Settings UI
 * - Read by agents to determine behavior
 * - Updated when user changes autopilot/copilot mode
 */
export interface SystemConfiguration {
  /** Configuration ID (always "global" for singleton) */
  id: string;

  /** Agent operation mode configuration */
  agentMode: AgentModeConfig;

  /** Signal detection configuration */
  signalDetection: SignalDetectionConfig;

  /** Linker Agent configuration (Phase 6: Universal Relations) */
  linkerAgent?: LinkerAgentConfig;

  /** Sweep cycle configuration (optional — older config docs predate it) */
  sweep?: SweepConfig;

  /** Notification preferences */
  notifications: NotificationConfig;

  /** API Keys for external services */
  apiKeys?: Record<string, string>;

  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;
}

// ============================================================================
// CUSTOM AGENT BUILDER TYPES (Phase 4.3)
// ============================================================================

/**
 * Type of task template for custom agents.
 * Each template defines a specific agent capability.
 */
export type AgentTaskTemplate =
  | 'find-technologies' // Search for new technologies in a domain
  | 'scan-patents' // Monitor patent databases
  | 'research-company' // Deep dive into a company
  | 'monitor-competitors' // Track competitor activities
  | 'trend-analysis' // Analyze market trends
  | 'look-for-use-cases' // Discover business applications
  | 'look-for-prototypes' // Discover prototype/POC ideas
  | 'enrich-existing' // Update existing radar entries
  | 'search-companies' // Discover companies matching criteria
  | 'scan-event'; // Scan event exhibitors for companies

/**
 * Context configuration for an agent.
 * Defines what the agent should focus on.
 */
export interface AgentContext {
  /** Strategy IDs to align with */
  strategies?: string[];
  /** Radar IDs to target */
  radars?: string[];
  /** Technology IDs to monitor */
  technologies?: string[];
  /** Company IDs to track */
  companies?: string[];
  /** Use case IDs to explore */
  useCases?: string[];
  /** Additional keywords for search */
  keywords?: string[];
  /** Custom prompt instructions */
  customPrompt?: string;
}

/**
 * Type of trigger event for agent execution.
 */
export type AgentTrigger =
  | { type: 'strategy-change'; strategyId: string }
  | { type: 'new-signal'; sourceType?: string }
  | { type: 'radar-update'; radarId: string }
  | { type: 'manual' };

/**
 * Represents a custom AI agent created by users.
 * Custom agents are configured through a wizard and run on schedules or triggers.
 *
 * **Agent Builder Workflow:**
 * 1. Basic Info - Name, description, icon
 * 2. Task Selection - Pick template (find-technologies, scan-patents, etc.)
 * 3. Context - Define what to monitor (strategies, radars, keywords)
 * 4. LLM Config - Choose model and features
 * 5. Output Config - Where results go and approval mode
 * 6. Schedule - When to run (daily, weekly, on-trigger)
 *
 * **Execution:**
 * - Runs via Inngest background jobs
 * - Creates signals or updates entities
 * - Tracks performance metrics
 * - Can run in autopilot (auto-approve) or copilot (review required) mode
 */
export interface CustomAgent {
  /** Unique identifier for the agent */
  id: string;

  // Basic Info (Step 1)
  /** Agent name */
  name: string;
  /** Agent description */
  description: string;
  /** Lucide icon name (optional) */
  icon?: string;

  // Task Configuration (Step 2)
  /** Task template this agent uses */
  taskTemplate: AgentTaskTemplate;
  /** Template-specific configuration */
  taskConfig: Record<string, any>;

  // Context Configuration (Step 3)
  /** What the agent should monitor/focus on */
  context: AgentContext;

  // LLM Configuration (Step 4)
  /** AI model and feature configuration */
  llmConfig: {
    /** Model to use */
    model: 'gemini-3.5-flash' | 'gemini-3-flash-preview' | 'gemini-2.5-pro';
    /** Thinking level for Gemini 2.0+ (optional) */
    thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
    /** Enable Google Search grounding */
    useGoogleSearch: boolean;
    /** Temperature for generation (0-1, default 0.7) */
    temperature?: number;
  };

  // Output Configuration (Step 5)
  /** How and where to output results */
  outputConfig: {
    /** Target radar ID for new entries (optional) */
    targetRadarId?: string;
    /** Type of output to create */
    targetType: 'signal' | 'technology' | 'company' | 'useCase';
    /** Approval mode */
    mode: 'copilot' | 'autopilot';
    /** Auto-approve threshold (0-100, used in autopilot mode) */
    autoApproveThreshold?: number;
  };

  // Schedule Configuration (Step 6)
  /** When the agent should run */
  schedule: {
    /** Schedule type */
    type: 'once' | 'daily' | 'weekly' | 'monthly' | 'trigger';
    /** Day of week for weekly (0-6, 0=Sunday) */
    dayOfWeek?: number;
    /** Day of month for monthly (1-31) */
    dayOfMonth?: number;
    /** Trigger events (for trigger type) */
    triggers?: AgentTrigger[];
  };

  // Metadata
  /** Current status */
  status: 'active' | 'paused' | 'draft';
  /** Timestamp of creation (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;
  /** User ID who created the agent */
  createdBy: string;
  /** Timestamp of last run (milliseconds since epoch) */
  lastRunAt?: number;
  /** Total number of times agent has run */
  runCount: number;

  // Performance Metrics
  /** Agent performance statistics */
  metrics: {
    /** Total signals generated by this agent */
    totalSignalsGenerated: number;
    /** Signals that were approved */
    signalsApproved: number;
    /** Signals that were rejected */
    signalsRejected: number;
    /** Average trust score of generated signals */
    avgTrustScore: number;
  };
}

/**
 * Represents a single execution run of a custom agent.
 * Stored in the 'agentRuns' collection in Firestore.
 *
 * Run Lifecycle:
 * 1. 'running' - Agent is currently executing
 * 2. 'completed' - Agent finished successfully
 * 3. 'failed' - Agent encountered an error
 * 4. 'cancelled' - Agent was manually cancelled
 */
export interface AgentRun {
  /** Unique identifier for the run */
  id: string;
  /** ID of the agent that ran */
  agentId: string;
  /** Name of the agent (for display without lookup) */
  agentName: string;
  /** Timestamp when the run started (milliseconds since epoch) */
  startedAt: number;
  /** Timestamp when the run completed (milliseconds since epoch) */
  completedAt?: number;
  /** Duration of the run in milliseconds */
  duration?: number;
  /** Current status of the run */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Number of signals created during this run */
  signalsCreated: number;
  /** Number of entities created (companies, technologies, use cases) */
  entitiesCreated: number;
  /** IDs of signals created during this run */
  signalIds: string[];
  /** IDs of entities created during this run */
  entityIds: string[];
  /** Error message if status is 'failed' */
  error?: string;
  /** Template used for this run */
  taskTemplate: string;
  /** Additional metadata about the run */
  metadata?: {
    /** Model used for the run */
    model?: string;
    /** Whether Google Search was used */
    usedGoogleSearch?: boolean;
    /** Number of duplicate signals detected */
    duplicatesDetected?: number;
    /** Number of signals auto-merged */
    signalsMerged?: number;
  };
}

// ============================================================================
// EPISODE (Phase 2: Temporal Graph Memory)
// ============================================================================

/**
 * An Episode groups proactive AgentObservation and mission Observation nodes
 * into temporal research sessions. Each Episode represents "one mission by
 * one agent" -- inspired by Graphiti (arXiv 2501.13956) temporal knowledge
 * graph architecture.
 */
export interface Episode {
  /** Unique identifier (deterministic for new mission lifecycles) */
  id: string;
  /** Name of the agent that ran this episode */
  agentName: string;
  /** Mission ID this episode belongs to */
  missionId: string;
  /** User who initiated the mission */
  userId: string;
  /** Summary of what the episode covered */
  summary: string;
  /** ISO timestamp when the episode started */
  startedAt: string;
  /** ISO timestamp when the episode ended */
  endedAt?: string;
  /** Number of observations recorded */
  observationCount: number;
  /** Current status */
  status: 'active' | 'completed' | 'failed' | 'abandoned';
}

/**
 * Agent execution checkpoint for resumability.
 * Enables agents to resume from failures.
 *
 * @phase Phase 4: Agent Durability
 */
export interface AgentCheckpoint {
  /** Checkpoint index */
  index: number;

  /** Step name */
  step: string;

  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'failed';

  /** Timestamp when step started */
  startedAt?: number;

  /** Timestamp when step completed */
  completedAt?: number;

  /** Step input data */
  input?: Record<string, unknown>;

  /** Step output data */
  output?: Record<string, unknown>;

  /** Error if step failed */
  error?: string;
}

// ============================================================================
// MISSION DISPATCH (DISC-002)
// ============================================================================

/**
 * Agents a user mission may be dispatched to — the single source of truth
 * shared by the startMission executor (validation) and the capability tools
 * (suggestions), so the assistant can never recommend a profile that
 * startMission would reject. defense-minister is deliberately absent: it is
 * dispatched by the verification pipeline, never by user missions.
 */
export const DISPATCHABLE_MISSION_AGENTS: ReadonlySet<string> = new Set([
  'scout',
  'evaluator',
  'linker',
  'curator',
  'strategist',
  'creator',
]);
