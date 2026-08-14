#!/usr/bin/env npx tsx
/**
 * @file seed-demo.ts
 * @description Seeds the Firestore emulator with a curated "State of AI 2026" demo dataset.
 *
 * Unlike seed-emulator.ts (comprehensive test data), this script creates a
 * thematic, storytelling dataset ideal for demos and onboarding. It showcases
 * the product with realistic AI-industry data that tells a coherent story
 * about AI trends in 2026.
 *
 * Usage:
 *   1. Start the Firebase emulator: npm run firebase:emulators
 *   2. Run this script: npx tsx scripts/seed-demo.ts
 *
 * The script is idempotent - it clears existing data before seeding.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

// MUST be the first import: loads .env.local into process.env so the Neo4j
// driver sees NEO4J_URI / NEO4J_PASSWORD at init time (static imports are
// hoisted above body-level dotenv.config()).
import './load-env-local';

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, collection, getDocs, writeBatch, doc } from 'firebase/firestore';
import type { Firestore as AdminFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { DEMO_USER_UID } from '@/lib/demo-credentials';
import type { Signal } from '@/lib/types';
import { DEFAULT_FIREBASE_EMULATOR_HOSTS, formatHostPort, parseEmulatorHost } from '@/lib/firebase-emulator-config';
import { radarPlacementSchema, ringSchema } from '@/lib/schemas/technology-schema';
import { missionSchema, type Mission } from '@/lib/schemas/mission';
import { agentRunSchema, type AgentRun } from '@/lib/schemas/agent-run';
import { assertPublishableReportHtml } from '@/lib/reports/publication-policy';
import { assertReportReferenceIntegrity } from '@/lib/reports/reference-integrity';
import { agentEventSchema, type AgentEvent } from '@/lib/schemas/agent-event';
import { runWriteTransaction } from '@/lib/graph/neo4j-client';
import { resolveGraphRuntime } from '@/lib/graph/runtime-mode';
import { seedPreferenceWeight } from '@/lib/graph/preferences';
import { getInsightAction } from '@/lib/graph/insight-actions';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import {
  generateAssessmentKey,
  proposedAssessmentSchema,
  type ProposedAssessment,
} from '@/lib/schemas/proposed-assessment';
import {
  generateProposedArtifactKey,
  proposedArtifactSchema,
  type ProposedArtifact,
} from '@/lib/schemas/proposed-artifact';
import { renderTechRadar } from '@/lib/super-graph/templates/tech-radar';
import { brandDark } from '@/lib/super-graph/design-tokens';
import type { Document as ResearchDocument } from '@/lib/types/entities';
import type { ProposedRelation } from '@/lib/types/relations';
import type { EvidenceInput } from '@/lib/graph/types';
import { buildRelationTripleLockEntry, RELATION_TRIPLE_LOCK_COLLECTION } from '@/lib/relations-triple-key';
import { RELATION_SYNC_OUTBOX_COLLECTION } from '@/lib/relation-sync-outbox';
import { ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION } from '@/lib/entity-graph-sync-outbox';
import { getScriptFirebaseProjectId } from './lib/firebase-config';
import { assertDisposableFirestoreResetTarget } from './lib/disposable-firestore-target';
import { syncSeedToNeo4j, type SeedEntity, type SeedRelation } from './lib/seed-graph-sync';
import {
  clearServerOwnedRadarPlacementCollection,
  SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS,
  seedRadarPlacementsWithAdmin,
} from './lib/seed-radar-placements-admin';
import type { DemoNarrativeManifest } from './demo-narrative/types';

// ============================================================================
// TYPES
// ============================================================================

interface DemoQuadrantConfig {
  id: string;
  name: string;
  description?: string;
  order: number;
}

interface DemoRadar {
  id: string;
  name: string;
  /** 1–8 quadrants as stable configs (ID-first). */
  quadrants: DemoQuadrantConfig[];
  entries: never[];
  ringSystem: string;
  createdAt: number;
  updatedAt: number;
  /** GRAPH-060 #2 — seeded ownership so the showcase user owns the demo radar. */
  createdBy: string;
}

interface DemoTechnology {
  id: string;
  name: string;
  description: string;
  /** Stable quadrant id from `DEMO_RADAR.quadrants`. */
  quadrantId: string;
  ring: 'Adopt' | 'Trial' | 'Assess' | 'Hold';
  status: 'Trending' | 'Stable' | 'Declining';
  tags: string[];
  costToPrototype: number;
  moved: 0 | 1;
  createdAt: number;
  updatedAt: number;
}

interface DemoCompany {
  id: string;
  name: string;
  description: string;
  website: string;
  industry: string;
  status: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// Seeded signals MUST satisfy the real Signal contract (src/lib/types) — a
// prior lowercase status ('approved') + invalid type ('technology') meant the
// triage queue, status counts and badges (which key on 'Detected'/'Validated'/
// 'Approved'/'Rejected' and SignalType) matched nothing, so the demo's signal
// panels rendered empty. Typing against Signal makes scripts:typecheck enforce
// the contract so the seed can never drift from it again.
type DemoSignal = Signal;

interface DemoStrategy {
  id: string;
  name: string;
  description: string;
  status: string;
  directives: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

interface DemoRelation {
  id: string;
  sourceId: string;
  sourceType: string;
  sourceSnapshot: { name: string };
  targetId: string;
  targetType: string;
  targetSnapshot: { name: string };
  relationType: 'develops' | 'uses' | 'impacts' | 'validates' | 'supports';
  /**
   * 0-100 scale (matches production Relation.confidence / r.confidence — the
   * same contract everywhere else in the Relation Write Contract). Prior to
   * Task 16 (A1) this was a 0-1 display scale that the Neo4j-sync mapper
   * multiplied by 100 before writing to the graph, while the RAW value was
   * written straight to Firestore — rendering as a sub-1% badge in
   * RelationsTab. Storing 0-100 here fixes both.
   */
  confidence: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Whether this relation is agent-asserted (vs human-curated). Drives the
   * Neo4j sync's `assertedBy` — 'agent:linker' when true, 'user:system' when
   * false/unset — which in turn drives `asserterType` and the chat
   * assistant's claim-chip corroboration level (src/lib/claim-chips.ts):
   * curated relations render "★ Curated by you"; agent-asserted relations
   * with 2+ distinct evidence sources render "✓✓ Corroborated". Only set
   * `true` on relations that carry real evidence (see below) — evidence-less
   * agent relations would render as "unverified", a worse demo story.
   */
  aiSuggested?: boolean;
  /**
   * Optional 2-distinct-source evidence — gives the demo showcase real
   * multi-source corroboration so the chat assistant's ✓✓ "Corroborated"
   * claim chip (src/lib/claim-chips.ts) has something genuine to render
   * instead of only single-source/curated relations.
   */
  evidence?: Array<{ sourceType: EvidenceInput['sourceType']; snippet: string; sourceUrl?: string }>;
}

// ============================================================================
// SEED DATA DEFINITIONS
// ============================================================================

const now = Date.now();

/**
 * The single demo radar definition.
 */
export const DEMO_RADAR: DemoRadar = {
  id: 'ai-radar-2026',
  name: 'State of AI 2026',
  quadrants: [
    { id: 'q_foundation_models', name: 'Foundation Models', order: 0 },
    { id: 'q_ai_infrastructure', name: 'AI Infrastructure', order: 1 },
    { id: 'q_applied_ai', name: 'Applied AI', order: 2 },
    { id: 'q_emerging_paradigms', name: 'Emerging Paradigms', order: 3 },
  ],
  entries: [],
  ringSystem: 'Standard',
  createdAt: now,
  updatedAt: now,
  createdBy: DEMO_USER_UID,
};

/**
 * SKILL-002 — the demo's self-declared narrative manifest: which record is the
 * hero, the one canonical screenshot screen, and the end-to-end decision chain a
 * stranger should be able to follow. The demo-narrative contract validates the
 * seed against this (every id must exist and every hop must resolve), so the
 * story can never silently drift into an incoherent set of records.
 *
 * The chain resolves entirely through real seed foreign keys:
 *   signal ─(relation:validates)→ technology ─(radar placement)→ radar[HERO]
 *          ─(report covers the radar's placed tech)→ report ─(shared mission)→ agent run
 */
export const DEMO_NARRATIVE: DemoNarrativeManifest = {
  hero: { kind: 'radar', id: DEMO_RADAR.id, label: DEMO_RADAR.name },
  canonicalScreenshotRoute: '/visualizations/radar',
  decisionChain: [
    {
      kind: 'signal',
      id: 'signal-claude-swe-bench',
      label: 'Claude 4.5 achieves SOTA on SWE-bench',
      via: 'root',
    },
    { kind: 'technology', id: 'tech-claude-4-5', label: 'Claude 4.5', via: 'relation' },
    { kind: 'radar', id: DEMO_RADAR.id, label: DEMO_RADAR.name, via: 'placement' },
    {
      kind: 'report',
      id: 'report-state-of-ai-2026',
      label: 'State of AI 2026: Quarterly Radar Briefing',
      via: 'report-covers-radar-tech',
    },
    {
      kind: 'agentRun',
      id: 'run-demo-q2-briefing',
      label: 'Generated the "State of AI 2026" quarterly radar briefing',
      via: 'mission',
    },
  ],
};

/**
 * 12 technologies spread across 4 quadrants and 4 rings.
 */
export const DEMO_TECHNOLOGIES: DemoTechnology[] = [
  // ── Adopt ──────────────────────────────────────────────────────────────────
  {
    id: 'tech-claude-4-5',
    name: 'Claude 4.5',
    description:
      "Anthropic's flagship model excelling at complex reasoning, coding, and agentic tasks. Widely adopted for enterprise AI workflows and recognized for its safety-first design.",
    quadrantId: 'q_foundation_models',
    ring: 'Adopt',
    status: 'Trending',
    tags: ['llm', 'reasoning', 'enterprise', 'safety'],
    costToPrototype: 20,
    moved: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-vllm',
    name: 'vLLM',
    description:
      'High-throughput, memory-efficient inference engine for large language models. The de facto standard for self-hosted LLM serving with PagedAttention and continuous batching.',
    quadrantId: 'q_ai_infrastructure',
    ring: 'Adopt',
    status: 'Stable',
    tags: ['inference', 'serving', 'open-source'],
    costToPrototype: 30,
    moved: 0,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-rag-pipelines',
    name: 'RAG Pipelines',
    description:
      'Retrieval-Augmented Generation pipelines combining vector search with LLM generation. Essential for grounded enterprise Q&A and reducing hallucinations.',
    quadrantId: 'q_applied_ai',
    ring: 'Adopt',
    status: 'Stable',
    tags: ['rag', 'retrieval', 'enterprise', 'grounding'],
    costToPrototype: 25,
    moved: 0,
    createdAt: now,
    updatedAt: now,
  },
  // ── Trial ──────────────────────────────────────────────────────────────────
  {
    id: 'tech-gpt-5',
    name: 'GPT-5',
    description:
      "OpenAI's next-generation model with improved multi-modal reasoning and longer context windows. Being evaluated for complex enterprise use cases requiring deep analysis.",
    quadrantId: 'q_foundation_models',
    ring: 'Trial',
    status: 'Trending',
    tags: ['llm', 'multi-modal', 'reasoning'],
    costToPrototype: 40,
    moved: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-modal',
    name: 'Modal',
    description:
      'Serverless cloud platform purpose-built for AI workloads. Simplifies GPU provisioning and model deployment with a Python-first developer experience.',
    quadrantId: 'q_ai_infrastructure',
    ring: 'Trial',
    status: 'Trending',
    tags: ['serverless', 'gpu', 'deployment'],
    costToPrototype: 35,
    moved: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-ai-code-review',
    name: 'AI Code Review',
    description:
      'Automated code review systems powered by LLMs that catch bugs, suggest improvements, and enforce coding standards. Rapidly maturing from experiment to daily workflow.',
    quadrantId: 'q_applied_ai',
    ring: 'Trial',
    status: 'Trending',
    tags: ['devtools', 'code-quality', 'automation'],
    costToPrototype: 15,
    moved: 1,
    createdAt: now,
    updatedAt: now,
  },
  // ── Assess ─────────────────────────────────────────────────────────────────
  {
    id: 'tech-gemini-ultra-2',
    name: 'Gemini Ultra 2.0',
    description:
      "Google DeepMind's largest model with native multi-modal understanding across text, image, video, and code. Strong on benchmarks but enterprise adoption is still early.",
    quadrantId: 'q_foundation_models',
    ring: 'Assess',
    status: 'Trending',
    tags: ['llm', 'multi-modal', 'google'],
    costToPrototype: 50,
    moved: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-neuromorphic-chips',
    name: 'Neuromorphic Chips',
    description:
      'Brain-inspired computing hardware that processes information using spiking neural networks. Promises order-of-magnitude improvements in energy efficiency for inference.',
    quadrantId: 'q_emerging_paradigms',
    ring: 'Assess',
    status: 'Trending',
    tags: ['hardware', 'energy-efficiency', 'neuromorphic'],
    costToPrototype: 90,
    moved: 0,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-autonomous-agents',
    name: 'Autonomous Agents',
    description:
      'AI systems that plan, execute, and iterate on multi-step tasks with minimal human supervision. Rapidly evolving but reliability and safety remain open challenges.',
    quadrantId: 'q_applied_ai',
    ring: 'Assess',
    status: 'Trending',
    tags: ['agents', 'automation', 'orchestration'],
    costToPrototype: 45,
    moved: 1,
    createdAt: now,
    updatedAt: now,
  },
  // ── Hold ───────────────────────────────────────────────────────────────────
  {
    id: 'tech-fine-tuned-small-models',
    name: 'Fine-Tuned Small Models',
    description:
      'Task-specific fine-tuned models under 7B parameters. While cost-effective, the gap is narrowing as larger models become cheaper and more capable through distillation.',
    quadrantId: 'q_foundation_models',
    ring: 'Hold',
    status: 'Declining',
    tags: ['fine-tuning', 'small-models', 'cost-optimization'],
    costToPrototype: 60,
    moved: 0,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-quantum-ml',
    name: 'Quantum ML',
    description:
      'Machine learning algorithms designed for quantum computers. Despite theoretical promise, practical quantum advantage for ML workloads remains years away.',
    quadrantId: 'q_emerging_paradigms',
    ring: 'Hold',
    status: 'Stable',
    tags: ['quantum', 'research', 'long-term'],
    costToPrototype: 100,
    moved: 0,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'tech-prompt-engineering-frameworks',
    name: 'Prompt Engineering Frameworks',
    description:
      'Structured frameworks for prompt design and management. Being superseded by tool-use, function calling, and structured output APIs built into model providers.',
    quadrantId: 'q_emerging_paradigms',
    ring: 'Hold',
    status: 'Declining',
    tags: ['prompting', 'frameworks', 'deprecated'],
    costToPrototype: 10,
    moved: 0,
    createdAt: now,
    updatedAt: now,
  },
];

/**
 * 8 real AI companies.
 */
export const DEMO_COMPANIES: DemoCompany[] = [
  {
    id: 'company-anthropic',
    name: 'Anthropic',
    description:
      'AI safety company building reliable, interpretable, and steerable AI systems. Creator of the Claude model family.',
    website: 'https://www.anthropic.com',
    industry: 'AI',
    status: 'Active',
    tags: ['llm', 'safety', 'enterprise'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-openai',
    name: 'OpenAI',
    description:
      'Pioneer in large language models and generative AI. Creator of GPT and ChatGPT, driving mainstream AI adoption.',
    website: 'https://www.openai.com',
    industry: 'AI',
    status: 'Active',
    tags: ['llm', 'generative-ai', 'consumer'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-google-deepmind',
    name: 'Google DeepMind',
    description:
      "Google's AI research lab combining DeepMind and Google Brain. Develops Gemini models and pushes the frontier of AI research.",
    website: 'https://deepmind.google',
    industry: 'AI',
    status: 'Active',
    tags: ['research', 'llm', 'multi-modal'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-meta-ai',
    name: 'Meta AI',
    description:
      "Meta's AI division driving open-source model releases with the Llama family and advancing AI research across modalities.",
    website: 'https://ai.meta.com',
    industry: 'AI',
    status: 'Active',
    tags: ['open-source', 'llm', 'social'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-mistral',
    name: 'Mistral',
    description:
      'French AI lab building efficient, open-weight foundation models. Known for high performance-per-parameter and European AI sovereignty.',
    website: 'https://mistral.ai',
    industry: 'AI',
    status: 'Active',
    tags: ['open-weight', 'efficiency', 'european'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-cohere',
    name: 'Cohere',
    description: 'Enterprise-focused AI company specializing in NLP and retrieval models for business applications.',
    website: 'https://cohere.com',
    industry: 'AI',
    status: 'Active',
    tags: ['enterprise', 'nlp', 'retrieval'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-hugging-face',
    name: 'Hugging Face',
    description:
      'The open-source AI community hub hosting models, datasets, and tools. De facto platform for model sharing and collaboration.',
    website: 'https://huggingface.co',
    industry: 'AI',
    status: 'Active',
    tags: ['open-source', 'community', 'platform'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'company-databricks',
    name: 'Databricks',
    description:
      'Unified data and AI platform enabling enterprise data teams to build, train, and deploy AI models at scale.',
    website: 'https://www.databricks.com',
    industry: 'AI',
    status: 'Active',
    tags: ['data-platform', 'enterprise', 'lakehouse'],
    createdAt: now,
    updatedAt: now,
  },
];

/**
 * 6 signals with mixed statuses.
 */
export const DEMO_SIGNALS: DemoSignal[] = [
  {
    id: 'signal-claude-swe-bench',
    type: 'paper',
    title: 'Claude 4.5 achieves SOTA on SWE-bench',
    slug: 'claude-4-5-achieves-sota-on-swe-bench',
    description:
      "Anthropic's Claude 4.5 sets a new state-of-the-art on the SWE-bench benchmark for autonomous software engineering, solving 72% of real-world GitHub issues without human intervention.",
    source: 'Anthropic',
    url: 'https://www.anthropic.com/research/claude-4-5-swe-bench',
    date: now - 3 * 24 * 60 * 60 * 1000,
    detectedAt: now - 3 * 24 * 60 * 60 * 1000,
    relevanceScore: 92,
    alignmentScore: 88,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Approved',
    sentiment: 'positive',
    aiSummary:
      'A frontier coding benchmark result with direct relevance to the autonomous-agent radar. High relevance, strong strategic alignment.',
  },
  {
    id: 'signal-meta-llama-4',
    type: 'news',
    title: 'Meta releases Llama 4 with 1T parameters',
    slug: 'meta-releases-llama-4-with-1t-parameters',
    description:
      'Meta open-sources Llama 4, a 1-trillion parameter model that matches proprietary model performance. Includes Llama 4 Scout (17B active) and Llama 4 Maverick (400B active) variants.',
    source: 'Meta AI',
    url: 'https://ai.meta.com/blog/llama-4',
    date: now - 5 * 24 * 60 * 60 * 1000,
    detectedAt: now - 5 * 24 * 60 * 60 * 1000,
    relevanceScore: 84,
    alignmentScore: 71,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Approved',
    sentiment: 'neutral',
    aiSummary:
      'An open-weights frontier release with competitive implications. Relevant to the open-source model landscape on the radar.',
  },
  {
    id: 'signal-gpu-shortage-easing',
    type: 'news',
    title: 'GPU shortage easing as TSMC ramps 3nm production',
    slug: 'gpu-shortage-easing-as-tsmc-ramps-3nm-production',
    description:
      'Industry reports indicate the AI GPU shortage is beginning to ease as TSMC increases 3nm chip production capacity, potentially reducing costs for AI infrastructure by 30% in H2 2026.',
    source: 'Industry Report',
    url: '',
    date: now - 1 * 24 * 60 * 60 * 1000,
    detectedAt: now - 1 * 24 * 60 * 60 * 1000,
    relevanceScore: 63,
    alignmentScore: 55,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Detected',
    sentiment: 'positive',
    aiSummary:
      'A supply-side market signal on AI infrastructure cost. Moderate relevance; awaiting validation before triage.',
  },
  {
    id: 'signal-eu-ai-act-enforcement',
    type: 'filing',
    title: 'EU AI Act enforcement begins for high-risk systems',
    slug: 'eu-ai-act-enforcement-begins-for-high-risk-systems',
    description:
      'The European Union begins enforcing the AI Act for high-risk AI systems, requiring comprehensive documentation, testing, and human oversight for AI deployed in critical sectors.',
    source: 'European Commission',
    url: 'https://digital-strategy.ec.europa.eu/en/policies/ai-act',
    date: now - 2 * 24 * 60 * 60 * 1000,
    detectedAt: now - 2 * 24 * 60 * 60 * 1000,
    relevanceScore: 70,
    alignmentScore: 66,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Detected',
    sentiment: 'neutral',
    aiSummary: 'A regulatory signal affecting AI deployment obligations. Relevant to compliance-sensitive strategies.',
  },
  {
    id: 'signal-agent-framework-convergence',
    type: 'paper',
    title: 'Agent framework convergence around tool-use standards',
    slug: 'agent-framework-convergence-around-tool-use-standards',
    description:
      'Major agent frameworks (LangGraph, CrewAI, AutoGen) are converging on a shared tool-use protocol, signaling maturation of the autonomous agent ecosystem.',
    source: 'arXiv',
    url: 'https://arxiv.org/abs/2026.agent-convergence',
    date: now - 7 * 24 * 60 * 60 * 1000,
    detectedAt: now - 7 * 24 * 60 * 60 * 1000,
    relevanceScore: 81,
    alignmentScore: 79,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Validated',
    sentiment: 'positive',
    aiSummary:
      'Ecosystem-maturity signal for autonomous agents. High relevance; AI validation complete, awaiting human review.',
  },
  {
    id: 'signal-prompt-eng-declining',
    type: 'news',
    title: 'Prompt engineering roles declining as models improve',
    slug: 'prompt-engineering-roles-declining-as-models-improve',
    description:
      'Job postings for dedicated prompt engineers dropped 60% year-over-year as models become better at understanding intent and structured output APIs reduce the need for prompt craft.',
    source: 'Industry Report',
    url: '',
    date: now - 10 * 24 * 60 * 60 * 1000,
    detectedAt: now - 10 * 24 * 60 * 60 * 1000,
    relevanceScore: 41,
    alignmentScore: 38,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Rejected',
    sentiment: 'negative',
    aiSummary: 'A labor-market signal with limited strategic relevance. Reviewed and rejected as out of scope.',
  },
];

/**
 * 2 strategies.
 */
export const DEMO_STRATEGIES: DemoStrategy[] = [
  {
    id: 'strategy-ai-first',
    name: 'AI-First Product Development',
    description:
      'Embed AI capabilities into every product and workflow. Shift from AI as a feature to AI as the foundation, prioritizing model-native architectures and agent-driven automation.',
    status: 'active',
    directives: [
      'Every new product feature must evaluate AI-native implementation first',
      'Adopt Claude and RAG pipelines as standard building blocks across teams',
      'Establish AI quality gates: latency, accuracy, and safety benchmarks for all AI features',
    ],
    tags: ['ai-first', 'product', 'strategy'],
    createdAt: now - 60 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'strategy-open-source-ai',
    name: 'Open Source AI Ecosystem',
    description:
      'Leverage and contribute to the open-source AI ecosystem. Use open-weight models where appropriate, invest in community tools, and reduce vendor lock-in through portable architectures.',
    status: 'active',
    directives: [
      'Evaluate open-weight models (Llama, Mistral) for non-critical workloads to reduce API costs',
      'Contribute tooling and benchmarks back to the Hugging Face ecosystem',
      'Maintain model-agnostic abstractions to enable switching between providers',
    ],
    tags: ['open-source', 'ecosystem', 'cost-optimization'],
    createdAt: now - 45 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
];

/**
 * 8 relations connecting companies, signals, and strategies to technologies.
 */
export const DEMO_RELATIONS: DemoRelation[] = [
  // Company -> Technology
  {
    id: 'rel-anthropic-claude',
    sourceId: 'company-anthropic',
    sourceType: 'company',
    sourceSnapshot: { name: 'Anthropic' },
    targetId: 'tech-claude-4-5',
    targetType: 'technology',
    targetSnapshot: { name: 'Claude 4.5' },
    relationType: 'develops',
    confidence: 100,
    aiSuggested: true,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
    evidence: [
      {
        sourceType: 'web_ref',
        snippet:
          "Anthropic's product blog announced general availability of Claude 4.5, its flagship reasoning and coding model built for enterprise agentic workflows.",
        sourceUrl: 'https://www.anthropic.com/news/claude-4-5',
      },
      {
        sourceType: 'web_ref',
        snippet:
          "Independent tech coverage confirmed Claude 4.5 as Anthropic's primary enterprise-focused model, citing its safety-first design and improved tool-use reliability.",
        sourceUrl: 'https://techcrunch.com/2026/01/15/anthropic-launches-claude-4-5/',
      },
    ],
  },
  {
    id: 'rel-openai-gpt5',
    sourceId: 'company-openai',
    sourceType: 'company',
    sourceSnapshot: { name: 'OpenAI' },
    targetId: 'tech-gpt-5',
    targetType: 'technology',
    targetSnapshot: { name: 'GPT-5' },
    relationType: 'develops',
    confidence: 100,
    aiSuggested: true,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
    evidence: [
      {
        sourceType: 'web_ref',
        snippet:
          "OpenAI's release notes describe GPT-5 as its next-generation multi-modal model with extended context windows for enterprise reasoning tasks.",
        sourceUrl: 'https://openai.com/index/gpt-5/',
      },
      {
        sourceType: 'web_ref',
        snippet:
          'A third-party benchmark review found GPT-5 improved multi-step reasoning accuracy over its predecessor across long-context tasks.',
        sourceUrl: 'https://www.theverge.com/2026/02/03/openai-gpt-5-review/',
      },
    ],
  },
  {
    id: 'rel-deepmind-gemini',
    sourceId: 'company-google-deepmind',
    sourceType: 'company',
    sourceSnapshot: { name: 'Google DeepMind' },
    targetId: 'tech-gemini-ultra-2',
    targetType: 'technology',
    targetSnapshot: { name: 'Gemini Ultra 2.0' },
    relationType: 'develops',
    confidence: 100,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'rel-huggingface-vllm',
    sourceId: 'company-hugging-face',
    sourceType: 'company',
    sourceSnapshot: { name: 'Hugging Face' },
    targetId: 'tech-vllm',
    targetType: 'technology',
    targetSnapshot: { name: 'vLLM' },
    relationType: 'supports',
    confidence: 85,
    aiSuggested: true,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
    evidence: [
      {
        sourceType: 'web_ref',
        snippet:
          'The vLLM project changelog lists Hugging Face engineers as core contributors upstreaming PagedAttention and continuous-batching optimizations.',
        sourceUrl: 'https://github.com/vllm-project/vllm/blob/main/CHANGELOG.md',
      },
      {
        sourceType: 'web_ref',
        snippet:
          "Hugging Face's engineering blog details its investment in vLLM as the recommended serving backend for Inference Endpoints.",
        sourceUrl: 'https://huggingface.co/blog/vllm-inference-endpoints',
      },
    ],
  },
  // Signal -> Technology
  {
    id: 'rel-signal-claude-benchmark',
    sourceId: 'signal-claude-swe-bench',
    sourceType: 'signal',
    sourceSnapshot: { name: 'Claude 4.5 achieves SOTA on SWE-bench' },
    targetId: 'tech-claude-4-5',
    targetType: 'technology',
    targetSnapshot: { name: 'Claude 4.5' },
    relationType: 'validates',
    confidence: 95,
    aiSuggested: true,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
    evidence: [
      {
        sourceType: 'web_ref',
        snippet:
          'The public SWE-bench leaderboard recorded Claude 4.5 at the top resolved-issue rate among evaluated models.',
        sourceUrl: 'https://www.swebench.com/leaderboard.html',
      },
      {
        sourceType: 'web_ref',
        snippet:
          'A follow-up engineering analysis reproduced the SWE-bench result and attributed the gain to improved multi-file patch planning.',
        sourceUrl: 'https://www.anthropic.com/research/swe-bench-claude-4-5',
      },
    ],
  },
  {
    id: 'rel-signal-agents-convergence',
    sourceId: 'signal-agent-framework-convergence',
    sourceType: 'signal',
    sourceSnapshot: { name: 'Agent framework convergence around tool-use standards' },
    targetId: 'tech-autonomous-agents',
    targetType: 'technology',
    targetSnapshot: { name: 'Autonomous Agents' },
    relationType: 'impacts',
    confidence: 80,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
  },
  // Strategy -> Technology
  {
    id: 'rel-strategy-aifirst-rag',
    sourceId: 'strategy-ai-first',
    sourceType: 'strategy',
    sourceSnapshot: { name: 'AI-First Product Development' },
    targetId: 'tech-rag-pipelines',
    targetType: 'technology',
    targetSnapshot: { name: 'RAG Pipelines' },
    relationType: 'supports',
    confidence: 90,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'rel-strategy-oss-vllm',
    sourceId: 'strategy-open-source-ai',
    sourceType: 'strategy',
    sourceSnapshot: { name: 'Open Source AI Ecosystem' },
    targetId: 'tech-vllm',
    targetType: 'technology',
    targetSnapshot: { name: 'vLLM' },
    relationType: 'supports',
    confidence: 85,
    createdBy: 'demo-seed',
    createdAt: now,
    updatedAt: now,
  },
];

/**
 * Canonical Firestore relation documents. The nested snapshot ids/types make
 * seeded rows discoverable by the same relation queries and cascade deletes as
 * app-created rows; top-level ids remain for the demo graph-sync mapper.
 */
export const DEMO_RELATION_DOCUMENTS = DEMO_RELATIONS.map((relation) => ({
  ...relation,
  sourceSnapshot: {
    ...relation.sourceSnapshot,
    id: relation.sourceId,
    type: relation.sourceType,
    snapshotAt: relation.createdAt,
  },
  targetSnapshot: {
    ...relation.targetSnapshot,
    id: relation.targetId,
    type: relation.targetType,
    snapshotAt: relation.createdAt,
  },
}));

/** Deterministic uniqueness locks paired one-to-one with demo relations. */
export const DEMO_RELATION_TRIPLE_LOCKS = DEMO_RELATIONS.map((relation) =>
  buildRelationTripleLockEntry(
    relation.id,
    relation.sourceId,
    relation.targetId,
    relation.relationType,
    relation.createdAt
  )
);

// ============================================================================
// DEMO REPORTS — agent-generated HTML reports that would normally be
// produced by Creator-agent missions. Seeded so /reports has content the
// first time a visitor opens the showcase.
//
// The flagship "State of AI 2026" briefing is brand-exact: it links
// public/css/report-brand.css, uses the agreed report component vocabulary,
// and derives every headline number (stat cards, ring movements, the inline
// radar SVG) from the seed arrays above so the report can never drift out of
// sync with the data it describes.
// ============================================================================

/** Ring order from outermost to innermost — `moved: 1` means moved one ring inward. */
const RING_ORDER: ReadonlyArray<DemoTechnology['ring']> = ['Hold', 'Assess', 'Trial', 'Adopt'];

/** The ring a `moved: 1` technology came from (one band further out). */
function ringMovedFrom(ring: DemoTechnology['ring']): DemoTechnology['ring'] | undefined {
  const ringIndex = RING_ORDER.indexOf(ring);
  return ringIndex > 0 ? RING_ORDER[ringIndex - 1] : undefined;
}

/** Editorial one-liners for the ring-movement table, keyed by technology id. */
const MOVEMENT_RATIONALE: Record<string, string> = {
  'tech-claude-4-5': 'Sustained SOTA on tool-use and coding benchmarks; production agent runtimes now ship on it.',
  'tech-gpt-5': 'Multi-modal reasoning gains warrant scoped pilots on long-context analysis workloads.',
  'tech-modal': 'Python-first GPU provisioning removed the platform-team bottleneck in early pilots.',
  'tech-ai-code-review': 'Bug-catch precision cleared the internal quality gate; joining the default PR workflow.',
  'tech-gemini-ultra-2':
    'Benchmark-strong, but enterprise references remain thin and grounding latency is under review.',
  'tech-autonomous-agents':
    'Framework convergence is real; evaluation methodology is still immature — probe, do not roll out.',
};

const MOVED_TECHNOLOGIES = DEMO_TECHNOLOGIES.filter((tech) => tech.moved === 1);

const MOVEMENT_TABLE_ROWS = MOVED_TECHNOLOGIES.map((tech) => {
  const from = ringMovedFrom(tech.ring) ?? tech.ring;
  const rationale = MOVEMENT_RATIONALE[tech.id] ?? 'Repositioned after the Q2 2026 review.';
  return `      <tr><td class="label-col">${tech.name}</td><td>${from}</td><td class="good">${tech.ring}</td><td>${rationale}</td></tr>`;
}).join('\n');

/**
 * The inline radar figure, rendered through the platform's own diagrammer
 * (`renderTechRadar` — the same template Creator-agent reports embed) against
 * the seeded radar data, with brand-dark tokens. The font stack is overridden
 * with a single-quoted variant: the shared token value contains double quotes
 * ("Inter Display"), which breaks the SVG's XML `font-family` attribute when
 * the markup is parsed as strict XML.
 */
const REPORT_RADAR_TOKENS = ((): ReturnType<typeof brandDark> => {
  const tokens = brandDark();
  return {
    ...tokens,
    type: { ...tokens.type, family: "Inter, 'Inter Display', system-ui, -apple-system, sans-serif" },
  };
})();

const REPORT_RADAR_SVG = renderTechRadar(
  {
    quadrants: DEMO_RADAR.quadrants,
    rings: ['Adopt', 'Trial', 'Assess', 'Hold'],
    items: DEMO_TECHNOLOGIES.map((tech) => ({
      name: tech.name,
      quadrantId: tech.quadrantId,
      ring: tech.ring,
      movement: tech.moved === 1 ? ('in' as const) : ('stable' as const),
    })),
    title: 'State of AI 2026 — Q2 Radar Snapshot',
  },
  REPORT_RADAR_TOKENS
);

const SIGNAL_STATUS_COUNT = (status: DemoSignal['status']): number =>
  DEMO_SIGNALS.filter((signal) => signal.status === status).length;

export const DEMO_REPORTS = [
  {
    id: 'report-state-of-ai-2026',
    title: 'State of AI 2026: Quarterly Radar Briefing',
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>State of AI 2026: Quarterly Radar Briefing</title>
  <link rel="stylesheet" href="/css/report-brand.css">
</head>
<body>
  <header class="report-header">
    <div class="header-label">Radarist · Quarterly Radar Briefing</div>
    <h1 class="report-title">State of AI <span>2026</span></h1>
    <p class="report-subtitle">The Q2 posture across foundation models, AI infrastructure, applied AI, and emerging paradigms — ${DEMO_TECHNOLOGIES.length} technologies, ${MOVED_TECHNOLOGIES.length} ring movements, and one clear headline: the agent layer is now a deployable surface.</p>
    <div class="header-meta">
      <span class="meta-item"><strong>Published</strong> · 2026-05-08</span>
      <span class="meta-item"><strong>Author</strong> · Creator agent</span>
      <span class="meta-item"><strong>Scope</strong> · ${DEMO_TECHNOLOGIES.length} technologies / ${DEMO_RADAR.quadrants.length} quadrants</span>
    </div>
  </header>

  <nav class="toc" aria-label="Contents">
    <div class="section-label">Contents</div>
    <a href="#s-exec">01 · Executive Summary</a>
    <a href="#s-landscape">02 · The Radar at a Glance</a>
    <a href="#s-models">03 · Foundation Models</a>
    <a href="#s-infra">04 · AI Infrastructure</a>
    <a href="#s-agents">05 · Applied AI &amp; Regulation</a>
    <a href="#s-movements">06 · Ring Movements</a>
    <a href="#s-recommendations">07 · Recommended Actions</a>
    <a href="#s-sources">08 · Sources &amp; Methods</a>
    <a href="#s-limitations">09 · Limitations</a>
  </nav>

  <main>
    <section class="section" id="s-exec">
      <div class="container">
        <div class="section-label">01 · Executive Summary</div>
        <h2 class="section-title">The agent layer stops being an experiment</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p>Q2 2026 confirms the divergence between <strong>foundation-model</strong> and <strong>agent-orchestration</strong> investment. The quarter's strongest signal — Claude 4.5 setting a new state of the art on the SWE-bench software-engineering benchmark, resolving 72% of scoped real-world GitHub issues end-to-end<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a><a class="cite-link" href="#ref-2"><sup class="cite">[2]</sup></a> — reset baseline expectations for autonomous coding pipelines and pulled the whole agent stack inward on the radar.</p>
          <p>Meanwhile the cost side of the ledger keeps improving: high-throughput open-source serving is now a commodity<a class="cite-link" href="#ref-3"><sup class="cite">[3]</sup></a>, GPU supply is loosening, and open-weight releases keep pricing pressure on the frontier labs<a class="cite-link" href="#ref-5"><sup class="cite">[5]</sup></a>. The constraint on applied AI in 2026 is no longer capability or unit cost — it is evaluation methodology and compliance readiness<a class="cite-link" href="#ref-6"><sup class="cite">[6]</sup></a>.</p>
        </div>
        <div class="insight-box">
          <p>The agent layer is no longer an experiment — it is a deployable surface. ${MOVED_TECHNOLOGIES.length} of ${DEMO_TECHNOLOGIES.length} tracked technologies moved one ring inward this cycle, and none moved outward.</p>
          <div class="insight-source">Creator agent synthesis · Q2 2026 radar review</div>
        </div>
      </div>
    </section>

    <section class="section" id="s-landscape">
      <div class="container">
        <div class="section-label">02 · The Radar at a Glance</div>
        <h2 class="section-title">${DEMO_TECHNOLOGIES.length} technologies, ${DEMO_RADAR.quadrants.length} quadrants, one picture</h2>
        <div class="section-divider"></div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-number">${DEMO_TECHNOLOGIES.length}</div>
            <div class="stat-label">Technologies placed on the radar</div>
            <div class="stat-source">Radar snapshot · ${DEMO_RADAR.quadrants.length} quadrants × 4 rings</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">${MOVED_TECHNOLOGIES.length}</div>
            <div class="stat-label">Ring movements this cycle — all inward</div>
            <div class="stat-source">Placement movement history, Q2 2026</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">${DEMO_COMPANIES.length}</div>
            <div class="stat-label">Companies tracked across the ecosystem</div>
            <div class="stat-source">Company library · ${DEMO_RELATIONS.length} curated relations</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">${DEMO_SIGNALS.length}</div>
            <div class="stat-label">Signals triaged this quarter</div>
            <div class="stat-source">${SIGNAL_STATUS_COUNT('Approved')} approved · ${SIGNAL_STATUS_COUNT('Validated')} validated · ${SIGNAL_STATUS_COUNT('Detected')} in triage · ${SIGNAL_STATUS_COUNT('Rejected')} rejected</div>
          </div>
        </div>
        <figure class="chart-container">
          <figcaption class="chart-title">Q2 2026 radar snapshot — rendered from the live placement data</figcaption>
          ${REPORT_RADAR_SVG}
        </figure>
        <div class="prose">
          <p>The picture is asymmetric by design. <strong>Foundation Models</strong> concentrate in the inner rings (Claude 4.5 at Adopt, GPT-5 at Trial), <strong>AI Infrastructure</strong> follows one step behind, <strong>Applied AI</strong> is climbing fastest, and <strong>Emerging Paradigms</strong> remain deliberately parked at Assess and Hold until the evidence catches up with the ambition.</p>
        </div>
      </div>
    </section>

    <section class="section" id="s-models">
      <div class="container">
        <div class="section-label">03 · Foundation Models</div>
        <h2 class="section-title">The frontier resets — and open weights keep the pressure on</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p>Three frontier families define the quarter. The practical question for most teams is no longer "which model is smartest?" but "which model is the safest default for agentic workloads, and what does the fallback tier look like?"</p>
        </div>
        <div class="benchmark-grid">
          <div class="benchmark-card">
            <div class="benchmark-org">Anthropic</div>
            <div class="benchmark-model">Claude 4.5</div>
            <div class="benchmark-body">Sustained state of the art on tool-use and repository-scale coding evaluations<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a><a class="cite-link" href="#ref-2"><sup class="cite">[2]</sup></a>. Production agent runtimes now ship on it; the safety-first posture matters for regulated deployments.</div>
            <div class="benchmark-tags"><span class="tag">Adopt</span><span class="tag">Agentic coding</span><span class="tag">Enterprise</span></div>
          </div>
          <div class="benchmark-card blue">
            <div class="benchmark-org">OpenAI</div>
            <div class="benchmark-model">GPT-5</div>
            <div class="benchmark-body">Stronger multi-modal reasoning and longer context windows. The gains are real but the enterprise case is still being written — scoped pilots on long-context analysis are the right exposure.</div>
            <div class="benchmark-tags"><span class="tag">Trial</span><span class="tag">Multi-modal</span><span class="tag">Long context</span></div>
          </div>
          <div class="benchmark-card purple">
            <div class="benchmark-org">Google DeepMind</div>
            <div class="benchmark-model">Gemini Ultra 2.0</div>
            <div class="benchmark-body">Native multi-modal understanding across text, image, video, and code. Benchmark-strong, but enterprise references remain thin and grounding latency on long-context tasks is under review.</div>
            <div class="benchmark-tags"><span class="tag">Assess</span><span class="tag">Multi-modal</span><span class="tag">Early adoption</span></div>
          </div>
        </div>
        <div class="prose">
          <p>Underneath the frontier, the open-weight ecosystem — Meta's Llama family<a class="cite-link" href="#ref-5"><sup class="cite">[5]</sup></a>, Mistral's efficiency-focused releases — keeps a hard floor under API pricing and a credible exit path from vendor lock-in. That is exactly the wedge the <strong>Open Source AI Ecosystem</strong> strategy is built on. The counterweight: <strong>fine-tuned small models</strong> stay on Hold, because distillation keeps closing their cost advantage from above.</p>
        </div>
      </div>
    </section>

    <section class="section" id="s-infra">
      <div class="container">
        <div class="section-label">04 · AI Infrastructure</div>
        <h2 class="section-title">Inference economics bend in the buyer's favor</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p><strong>vLLM</strong> holds Adopt as the de facto standard for self-hosted serving: PagedAttention and continuous batching made high-throughput inference an open-source commodity rather than a proprietary edge<a class="cite-link" href="#ref-3"><sup class="cite">[3]</sup></a><a class="cite-link" href="#ref-4"><sup class="cite">[4]</sup></a>. One step out, <strong>Modal</strong> moves to Trial: serverless, Python-first GPU provisioning removed the platform-team bottleneck in early pilots<a class="cite-link" href="#ref-10"><sup class="cite">[10]</sup></a>.</p>
          <p>On the hardware side, the supply story is finally turning. Industry reporting points to TSMC's 3nm ramp easing the GPU squeeze, with meaningful unit-cost reduction expected in H2 2026 — a still-unverified but directionally consistent signal in this quarter's triage queue.</p>
        </div>
        <div class="callout-success">Cost tailwind: if the H2 2026 GPU supply signal validates, re-run every inference-cost-sensitive business case before committing to annual capacity contracts — the break-even points will have moved.</div>
      </div>
    </section>

    <section class="section" id="s-agents">
      <div class="container">
        <div class="section-label">05 · Applied AI &amp; Regulation</div>
        <h2 class="section-title">Agents, retrieval, and the compliance clock</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p><strong>Autonomous agents</strong> climb to Assess on the strength of two converging trends: agent-design patterns have stabilized around simple, composable tool-use loops<a class="cite-link" href="#ref-7"><sup class="cite">[7]</sup></a>, and the major frameworks are consolidating on shared tool-use standards in the Model Context Protocol lineage<a class="cite-link" href="#ref-8"><sup class="cite">[8]</sup></a>. What has not stabilized is evaluation methodology — which is why the ring is Assess, not Trial.</p>
          <p><strong>RAG pipelines</strong> stay at Adopt as the default grounding pattern for enterprise Q&amp;A<a class="cite-link" href="#ref-9"><sup class="cite">[9]</sup></a>, and <strong>AI code review</strong> enters Trial after clearing the internal bug-catch quality gate.</p>
        </div>
        <div class="jtbd-block">
          <div class="jtbd-label">Job to be done</div>
          <div class="jtbd-job">When the maintenance backlog outgrows the team, hire an agent loop to clear scoped bug-fix tasks, so engineers stay on feature work.</div>
          <div class="jtbd-struggle">Struggling moment: <strong>well-tested repositories</strong> see the highest autonomous resolve rates — teams without executable feedback loops should fix test coverage before hiring the agent.</div>
        </div>
        <div class="callout-warning">Compliance clock: EU AI Act obligations for high-risk systems are now enforceable<a class="cite-link" href="#ref-6"><sup class="cite">[6]</sup></a>. Any radar bet that touches employment, credit, essential services, or law enforcement must carry conformity cost in its business case — reclassifying after build is substantially more expensive.</div>
      </div>
    </section>

    <section class="section" id="s-movements">
      <div class="container">
        <div class="section-label">06 · Ring Movements</div>
        <h2 class="section-title">${MOVED_TECHNOLOGIES.length} placements moved inward this quarter</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p>Every movement this cycle was toward adoption — one promotion into Adopt, three into Trial, two into Assess. The table below is derived directly from the placement history; each move carries the review rationale.</p>
        </div>
        <table class="compare-table">
          <thead>
            <tr><th>Technology</th><th>From</th><th>To</th><th>Why it moved</th></tr>
          </thead>
          <tbody>
${MOVEMENT_TABLE_ROWS}
          </tbody>
        </table>
        <div class="insight-box">
          <p>Signal of the quarter: "Claude 4.5 achieves SOTA on SWE-bench" (confidence 95) validated a category we had tracked at Trial for three quarters<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a><a class="cite-link" href="#ref-2"><sup class="cite">[2]</sup></a> — the direct trigger for this cycle's Adopt promotion.</p>
          <div class="insight-source">Signal triage, Q2 2026 · approved with linked evidence</div>
        </div>
      </div>
    </section>

    <section class="section" id="s-recommendations">
      <div class="container">
        <div class="section-label">07 · Recommended Actions</div>
        <h2 class="section-title">What to do about it</h2>
        <div class="section-divider"></div>
        <div class="action-grid">
          <div class="action-card">
            <div class="action-phase">Now · Q2</div>
            <div class="action-title">Re-baseline agent economics</div>
            <ul class="action-items">
              <li>Re-baseline the Q3 prototype budget against the Claude 4.5 + tool-use envelope.</li>
              <li>Move the Open Source AI Ecosystem strategy from aspiration to active investment.</li>
              <li>Confirm RAG as the default grounding pattern for every new AI feature.</li>
            </ul>
          </div>
          <div class="action-card">
            <div class="action-phase">Next · Q3</div>
            <div class="action-title">Pilot the Trial ring</div>
            <ul class="action-items">
              <li>Run a scoped GPT-5 pilot on long-context analysis workloads.</li>
              <li>Stand up Modal for burst GPU provisioning; keep vLLM for steady-state serving.</li>
              <li>Put AI code review on the default PR path for one product team.</li>
            </ul>
          </div>
          <div class="action-card">
            <div class="action-phase">Watch · H2</div>
            <div class="action-title">Hold the line on hype</div>
            <ul class="action-items">
              <li>Keep quantum ML and neuromorphic hardware parked until reproducible advantage appears.</li>
              <li>Track EU AI Act conformity costs in every high-risk-adjacent business case.</li>
              <li>Revisit fine-tuned small models only if distillation economics reverse.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="s-sources">
      <div class="container">
        <div class="section-label">08 · Sources &amp; Methods</div>
        <h2 class="section-title">How this briefing was assembled</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p>This briefing was compiled from the seeded demo dataset; illustrative of the platform's generated reports. Every headline number is computed from that dataset at seed time: technology, company, and signal counts come from the entity library; ring movements are derived from the radar placement history; and the radar figure is rendered by the platform's own diagrammer from the same placements — the figure cannot disagree with the table.</p>
          <p>External references [1]–[10] are public primary sources — vendor research posts, peer-reviewed papers, official documentation, and the EU regulation text — cited to ground the direction of each claim. Signal-derived figures carry their triage confidence inline.</p>
        </div>
      </div>
    </section>

    <section class="section" id="s-limitations">
      <div class="container">
        <div class="section-label">09 · Limitations</div>
        <h2 class="section-title">Read this before acting on it</h2>
        <div class="section-divider"></div>
        <div class="prose">
          <p><strong>Illustrative dataset.</strong> The underlying records are a curated demonstration corpus, not a production research pipeline. Counts are small by design (${DEMO_TECHNOLOGIES.length} technologies, ${DEMO_SIGNALS.length} signals), so treat proportions as narrative, not statistics.</p>
          <p><strong>Reference scope.</strong> The cited public sources support the direction and methodology of each claim — they do not verify the specific benchmark figures attributed to 2026 model releases in the seeded signals.</p>
          <p><strong>Confidence values are curated.</strong> Signal and relation confidences were set editorially to demonstrate the triage workflow, not produced by the live scoring pipeline.</p>
          <p><strong>Single-radar view.</strong> The briefing reads one radar with one ring system; portfolio-level trade-offs across multiple radars are out of scope.</p>
        </div>
      </div>
    </section>
  </main>

  <section class="references-section">
    <div class="container">
      <div class="section-label">References</div>
      <ol class="references-list">
        <li id="ref-1"><span class="ref-num">[1]</span><span>Anthropic, "Raising the bar on SWE-bench Verified with Claude 3.5 Sonnet." <span class="ref-source">https://www.anthropic.com/research/swe-bench-sonnet</span></span></li>
        <li id="ref-2"><span class="ref-num">[2]</span><span>C. E. Jimenez et al., "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?" arXiv:2310.06770. <span class="ref-source">https://arxiv.org/abs/2310.06770</span></span></li>
        <li id="ref-3"><span class="ref-num">[3]</span><span>W. Kwon et al., "Efficient Memory Management for Large Language Model Serving with PagedAttention," arXiv:2309.06180. <span class="ref-source">https://arxiv.org/abs/2309.06180</span></span></li>
        <li id="ref-4"><span class="ref-num">[4]</span><span>vLLM Team, "vLLM: Easy, Fast, and Cheap LLM Serving with PagedAttention." <span class="ref-source">https://blog.vllm.ai/2023/06/20/vllm.html</span></span></li>
        <li id="ref-5"><span class="ref-num">[5]</span><span>Meta AI, "The Llama 4 herd: The beginning of a new era of natively multimodal AI innovation." <span class="ref-source">https://ai.meta.com/blog/llama-4-multimodal-intelligence/</span></span></li>
        <li id="ref-6"><span class="ref-num">[6]</span><span>Regulation (EU) 2024/1689 (Artificial Intelligence Act), Official Journal of the European Union. <span class="ref-source">https://eur-lex.europa.eu/eli/reg/2024/1689/oj</span></span></li>
        <li id="ref-7"><span class="ref-num">[7]</span><span>Anthropic, "Building effective agents." <span class="ref-source">https://www.anthropic.com/engineering/building-effective-agents</span></span></li>
        <li id="ref-8"><span class="ref-num">[8]</span><span>Anthropic, "Introducing the Model Context Protocol." <span class="ref-source">https://www.anthropic.com/news/model-context-protocol</span></span></li>
        <li id="ref-9"><span class="ref-num">[9]</span><span>P. Lewis et al., "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks," arXiv:2005.11401. <span class="ref-source">https://arxiv.org/abs/2005.11401</span></span></li>
        <li id="ref-10"><span class="ref-num">[10]</span><span>Modal Labs, "Modal documentation — Guide." <span class="ref-source">https://modal.com/docs/guide</span></span></li>
      </ol>
    </div>
  </section>

  <footer class="report-footer">
    <div class="container">
      <p class="footer-disclaimer">Generated by the Creator agent · compiled from the seeded demo dataset; illustrative of the platform's generated reports · data snapshot 2026-05-08</p>
    </div>
  </footer>
</body>
</html>`,
    createdAt: now,
    createdBy: 'agent',
    agentType: 'creator',
    missionId: 'demo-mission-q2-briefing',
    ownerId: DEMO_USER_UID,
    entityIds: [
      'tech-claude-4-5',
      'tech-rag-pipelines',
      'tech-vllm',
      'tech-autonomous-agents',
      'tech-gemini-ultra-2',
      'tech-gpt-5',
      'tech-modal',
      'tech-ai-code-review',
      'signal-claude-swe-bench',
      'signal-agent-framework-convergence',
      'signal-gpu-shortage-easing',
      'signal-eu-ai-act-enforcement',
      'strategy-open-source-ai',
      'strategy-ai-first',
    ],
    metadata: {
      description:
        'Brand-styled quarterly radar briefing: six inward ring movements, the SWE-bench breakthrough, inference-cost tailwinds, and recommended Q3 investment shifts — with an inline radar snapshot rendered from the seeded placements.',
      dataSnapshotAt: now,
    },
    // The DEMO_SCRIPT.md minute 8-9 stop opens /share/report/[id] — this is
    // the report that share link points at, so it must seed as shared.
    shared: true,
  },
  {
    id: 'report-rag-vs-finetuning',
    title: 'RAG vs. Fine-Tuning: When Each Pattern Wins',
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RAG vs. Fine-Tuning: When Each Pattern Wins</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1.25rem; color: #1a1a1a; line-height: 1.55; }
    h1 { font-size: 1.8rem; }
    h2 { margin-top: 1.75rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #e5e5e5; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
    th { background: #f8f8f8; }
  </style>
</head>
<body>
  <h1>RAG vs. Fine-Tuning: When Each Pattern Wins</h1>
  <p style="color:#666;">Decision memo · 2026-04-22 · Strategist agent</p>

  <p>Both retrieval-augmented generation and fine-tuning solve "the base model doesn't know our domain" but in incompatible ways. Picking wrong wastes 3–6 months of platform work.</p>

  <h2>Choose RAG when…</h2>
  <table>
    <tr><th>Signal</th><th>Why RAG fits</th></tr>
    <tr><td>Knowledge changes weekly or faster</td><td>Re-indexing is cheap; re-finetuning is not.</td></tr>
    <tr><td>You need to cite sources</td><td>RAG surfaces the retrieved passage natively.</td></tr>
    <tr><td>You have ≤ 100k high-quality documents</td><td>Vector recall scales linearly; fine-tune curves flatten.</td></tr>
    <tr><td>Latency tolerance ≥ 300 ms</td><td>Embedding + lookup adds a hop you can absorb.</td></tr>
  </table>

  <h2>Choose fine-tuning when…</h2>
  <table>
    <tr><th>Signal</th><th>Why fine-tune fits</th></tr>
    <tr><td>Domain has stable vocabulary</td><td>Drift cost is low.</td></tr>
    <tr><td>You need style or format conformance</td><td>RAG can retrieve content but not enforce shape.</td></tr>
    <tr><td>Latency budget &lt; 200 ms</td><td>No retrieval round-trip.</td></tr>
    <tr><td>You have ≥ 10k carefully labeled examples</td><td>Fine-tune ROI inflects around this range.</td></tr>
  </table>

  <h2>The hybrid case</h2>
  <p>For most teams in 2026 the right answer is <strong>RAG first, fine-tune the retriever and reranker</strong>. Fine-tuning the generator itself buys little over a strong RAG + Claude 4.5 baseline.</p>
</body>
</html>`,
    createdAt: now,
    createdBy: 'agent',
    agentType: 'strategist',
    missionId: 'demo-mission-rag-decision',
    ownerId: DEMO_USER_UID,
    entityIds: ['tech-rag-pipelines', 'tech-claude-4-5'],
    metadata: {
      description:
        'Strategist-agent decision memo: when retrieval-augmented generation beats fine-tuning and vice versa, with the hybrid recommendation.',
      dataSnapshotAt: now,
    },
    shared: false,
  },
];

// ============================================================================
// DEMO VISUALIZATIONS — what the AI Assistant's image generation would
// have produced. Image URLs point at small inline SVG data URIs so the
// page renders without requiring Firebase Storage or external CDN.
// ============================================================================

function inlineSvg(label: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="600" height="400" fill="#0f172a"/>
  <rect x="40" y="40" width="520" height="320" rx="18" fill="url(#g)"/>
  <text x="300" y="200" text-anchor="middle" font-family="system-ui" font-size="28" fill="#fff" font-weight="700">${label}</text>
  <text x="300" y="240" text-anchor="middle" font-family="system-ui" font-size="14" fill="#fff" opacity="0.85">Demo infographic · seeded sample</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DEMO_VISUALIZATIONS = [
  {
    id: 'viz-agent-frameworks-2026',
    title: 'Agent framework adoption map · 2026 Q2',
    prompt: 'Compare adoption signal strength of leading agent frameworks',
    refinedPrompt:
      'Quadrant map showing leading agent frameworks (Claude Agent SDK, LangGraph, AutoGPT, AutoGen) plotted by adoption signal strength vs ecosystem breadth.',
    imageUrl: inlineSvg('Agent framework adoption', '#0ea5e9'),
    mimeType: 'image/png',
    style: 'professional',
    dataSnapshot: {
      entities: [
        { id: 'tech-autonomous-agents', name: 'Autonomous Agents', type: 'technology' },
        { id: 'tech-claude-4-5', name: 'Claude 4.5', type: 'technology' },
      ],
      description: 'Quadrant comparing four leading agent frameworks across 2026 Q2 signal volume.',
    },
    createdAt: now,
    createdBy: DEMO_USER_UID,
    userId: DEMO_USER_UID,
    shared: false,
    metadata: { model: 'gemini-3-pro-image-preview', width: 600, height: 400, sizeBytes: 1024 },
  },
  {
    id: 'viz-inference-cost-curve',
    title: 'Inference cost curve · Q1 2025 → Q2 2026',
    prompt: 'Show inference $/Mtoken trajectory across major model providers',
    refinedPrompt:
      'Line chart of inference cost per million tokens for Anthropic Claude, OpenAI GPT, and Google Gemini quarterly from Q1 2025 to Q2 2026.',
    imageUrl: inlineSvg('Inference cost trajectory', '#10b981'),
    mimeType: 'image/png',
    style: 'minimal',
    dataSnapshot: {
      entities: [
        { id: 'tech-claude-4-5', name: 'Claude 4.5', type: 'technology' },
        { id: 'tech-gemini-ultra-2', name: 'Gemini Ultra 2.0', type: 'technology' },
      ],
      description: 'Inference $/Mtoken decline across the three major providers over 6 quarters.',
    },
    createdAt: now,
    createdBy: DEMO_USER_UID,
    userId: DEMO_USER_UID,
    shared: false,
    metadata: { model: 'gemini-3-pro-image-preview', width: 600, height: 400, sizeBytes: 1024 },
  },
  {
    id: 'viz-rag-stack',
    title: 'RAG reference stack · 2026',
    prompt: 'Architecture diagram for a production RAG pipeline',
    refinedPrompt:
      'Architecture diagram showing ingestion → chunking → embedding → vector store → retrieval → reranking → Claude 4.5 generation, with cache + observability layers.',
    imageUrl: inlineSvg('RAG reference stack', '#a855f7'),
    mimeType: 'image/png',
    style: 'dark',
    dataSnapshot: {
      entities: [{ id: 'tech-rag-pipelines', name: 'RAG Pipelines', type: 'technology' }],
      description: 'Reference RAG architecture diagram with cache + observability layers.',
    },
    createdAt: now,
    createdBy: DEMO_USER_UID,
    userId: DEMO_USER_UID,
    shared: false,
    metadata: { model: 'gemini-3-pro-image-preview', width: 600, height: 400, sizeBytes: 1024 },
  },
];

// ============================================================================
// DEMO RADAR PLACEMENTS — decoupled (Technology + RadarPlacement) model.
// One placement per technology, derived from the legacy embedded
// quadrantId/ring/moved fields so the radar UI (which reads placements,
// not embedded fields) renders the same picture.
// ============================================================================

/**
 * The canonical Zod `radarPlacementSchema` types `movedFrom` as an object,
 * but every runtime writer/reader treats it as a plain ring string
 * (`radar-placement-service.ts` writes `movedFrom = currentData.ring`;
 * `PlacementsTab.tsx` renders it directly). Seed the runtime string shape
 * and validate against the schema with that one field aligned.
 */
export const demoRadarPlacementSchema = radarPlacementSchema.extend({
  movedFrom: ringSchema.optional(),
});

type DemoRadarPlacement = z.infer<typeof demoRadarPlacementSchema>;

/** Time-to-Impact horizon derived from ring maturity for the 3-D assessment UI. */
const TIME_TO_IMPACT_BY_RING: Record<DemoTechnology['ring'], 'H1' | 'H2' | 'H3'> = {
  Adopt: 'H1',
  Trial: 'H1',
  Assess: 'H2',
  Hold: 'H3',
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const DEMO_RADAR_PLACEMENTS: DemoRadarPlacement[] = DEMO_TECHNOLOGIES.map((tech) => {
  const ringIndex = RING_ORDER.indexOf(tech.ring);
  const movedFromRing = tech.moved === 1 && ringIndex > 0 ? RING_ORDER[ringIndex - 1] : undefined;

  return {
    id: `placement-${tech.id}`,
    technologyId: tech.id,
    radarId: DEMO_RADAR.id,
    quadrantId: tech.quadrantId,
    ring: tech.ring,
    timeToImpact: TIME_TO_IMPACT_BY_RING[tech.ring],
    technologySnapshot: { name: tech.name, slug: slugify(tech.name), snapshotUpdatedAt: now },
    // Movement info only where the legacy `moved` flag is set (Firestore
    // rejects `undefined` field values, so spread conditionally).
    ...(movedFromRing
      ? {
          movedFrom: movedFromRing,
          movedAt: now - 12 * 24 * 60 * 60 * 1000,
          rationale: `Moved from ${movedFromRing} after the Q2 2026 review.`,
        }
      : {}),
    createdAt: now,
    updatedAt: now,
    placedBy: DEMO_USER_UID,
  };
});

// ============================================================================
// DEMO PROPOSED RELATIONS — pending AI suggestions for the Linker Triage
// page (/triage/relations). Doc shape mirrors scripts/seed-emulator.ts and
// the `ProposedRelation` type (confidence is 0-100 here, unlike relations).
// ============================================================================

export const DEMO_PROPOSED_RELATIONS: ProposedRelation[] = [
  {
    id: 'prop-cohere-rag',
    sourceType: 'company',
    sourceId: 'company-cohere',
    sourceSnapshot: {
      type: 'company',
      id: 'company-cohere',
      name: 'Cohere',
      description: 'Enterprise-focused AI company specializing in NLP and retrieval models for business applications.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'tech-rag-pipelines',
    targetSnapshot: {
      type: 'technology',
      id: 'tech-rag-pipelines',
      name: 'RAG Pipelines',
      description: 'Retrieval-Augmented Generation pipelines combining vector search with LLM generation.',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 91,
    reasoning:
      'Cohere ships retrieval and rerank models purpose-built for enterprise RAG workloads, making it a vendor in the RAG pipeline space.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-demo-linker-001',
    createdAt: now - 1 * 24 * 60 * 60 * 1000,
    updatedAt: now - 1 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-databricks-rag',
    sourceType: 'company',
    sourceId: 'company-databricks',
    sourceSnapshot: {
      type: 'company',
      id: 'company-databricks',
      name: 'Databricks',
      description: 'Unified data and AI platform enabling enterprise data teams to build, train, and deploy AI models.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'tech-rag-pipelines',
    targetSnapshot: {
      type: 'technology',
      id: 'tech-rag-pipelines',
      name: 'RAG Pipelines',
      description: 'Retrieval-Augmented Generation pipelines combining vector search with LLM generation.',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 84,
    reasoning:
      'Databricks provides vector search and RAG tooling on its lakehouse platform, positioning it as a RAG pipeline vendor.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-demo-linker-001',
    createdAt: now - 1 * 24 * 60 * 60 * 1000,
    updatedAt: now - 1 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-mistral-small-models',
    sourceType: 'company',
    sourceId: 'company-mistral',
    sourceSnapshot: {
      type: 'company',
      id: 'company-mistral',
      name: 'Mistral',
      description: 'French AI lab building efficient, open-weight foundation models.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'tech-fine-tuned-small-models',
    targetSnapshot: {
      type: 'technology',
      id: 'tech-fine-tuned-small-models',
      name: 'Fine-Tuned Small Models',
      description: 'Task-specific fine-tuned models under 7B parameters.',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 74,
    reasoning:
      'Mistral publishes open-weight small models that teams commonly fine-tune for task-specific deployments.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'auto-linker',
    createdAt: now - 2 * 24 * 60 * 60 * 1000,
    updatedAt: now - 2 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-vllm-agents',
    sourceType: 'technology',
    sourceId: 'tech-vllm',
    sourceSnapshot: {
      type: 'technology',
      id: 'tech-vllm',
      name: 'vLLM',
      description: 'High-throughput, memory-efficient inference engine for large language models.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'tech-autonomous-agents',
    targetSnapshot: {
      type: 'technology',
      id: 'tech-autonomous-agents',
      name: 'Autonomous Agents',
      description: 'AI systems that plan, execute, and iterate on multi-step tasks with minimal human supervision.',
      snapshotAt: now,
    },
    relationType: 'enables',
    confidence: 67,
    reasoning:
      'Self-hosted high-throughput inference is the cost floor for agent loops; vLLM serving underpins most open-source agent deployments.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'auto-linker',
    createdAt: now - 3 * 24 * 60 * 60 * 1000,
    updatedAt: now - 3 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-modal-vllm',
    sourceType: 'technology',
    sourceId: 'tech-modal',
    sourceSnapshot: {
      type: 'technology',
      id: 'tech-modal',
      name: 'Modal',
      description: 'Serverless cloud platform purpose-built for AI workloads.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'tech-vllm',
    targetSnapshot: {
      type: 'technology',
      id: 'tech-vllm',
      name: 'vLLM',
      description: 'High-throughput, memory-efficient inference engine for large language models.',
      snapshotAt: now,
    },
    relationType: 'enables',
    confidence: 62,
    reasoning:
      'Modal provides on-demand GPU provisioning frequently used to host vLLM inference deployments without dedicated infrastructure.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-demo-linker-002',
    createdAt: now - 4 * 24 * 60 * 60 * 1000,
    updatedAt: now - 4 * 24 * 60 * 60 * 1000,
  },
  // DEMO-001 — the intentionally WRONG proposal: the decision narrative's reject
  // case at `/triage/relations`. Every other proposal above is a defensible AI
  // suggestion a reviewer would approve; this one is the counter-example that
  // shows why the human triage step exists. It is a plausible-sounding auto-linker
  // category error — Cohere ships NLP / retrieval / rerank models, NOT
  // autonomous-agent frameworks, so it is not a "vendor" of Autonomous Agents.
  // The high confidence is deliberate: it demonstrates that a confident AI
  // suggestion can still be wrong, so confidence is a prompt for review, not a
  // substitute for it. The paired ground truth is the curated Cohere→RAG-Pipelines
  // signal in `prop-cohere-rag` (correct) — same company, one right edge, one wrong.
  {
    id: 'prop-cohere-autonomous-agents',
    sourceType: 'company',
    sourceId: 'company-cohere',
    sourceSnapshot: {
      type: 'company',
      id: 'company-cohere',
      name: 'Cohere',
      description: 'Enterprise-focused AI company specializing in NLP and retrieval models for business applications.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'tech-autonomous-agents',
    targetSnapshot: {
      type: 'technology',
      id: 'tech-autonomous-agents',
      name: 'Autonomous Agents',
      description: 'AI systems that plan, execute, and iterate on multi-step tasks with minimal human supervision.',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 86,
    reasoning:
      'Cohere is a frontier AI vendor and autonomous agents are a fast-growing AI category, so Cohere is likely a vendor in the autonomous-agents space.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'auto-linker',
    createdAt: now - 1 * 24 * 60 * 60 * 1000,
    updatedAt: now - 1 * 24 * 60 * 60 * 1000,
  },
];

// ============================================================================
// DEMO MISSIONS + AGENT RUNS — completed mission history backing the two
// seeded reports (the reports already carry these missionId values), so the
// Missions/Activity surfaces show how the reports were produced.
// ============================================================================

export const DEMO_MISSIONS: Mission[] = [
  {
    id: 'demo-mission-q2-briefing',
    kind: 'research',
    userId: DEMO_USER_UID,
    prompt:
      'Create the quarterly "State of AI 2026" radar briefing: cover this cycle\'s ring movements, the strongest signal of the quarter, and recommended Q3 investment shifts.',
    agent: 'creator',
    status: 'completed',
    progress: 100,
    progressMessage: 'Report published',
    entities: [
      { id: 'tech-claude-4-5', name: 'Claude 4.5', type: 'technology', confidence: 0.97, agentName: 'creator' },
      { id: 'tech-rag-pipelines', name: 'RAG Pipelines', type: 'technology', confidence: 0.93, agentName: 'creator' },
      {
        id: 'signal-claude-swe-bench',
        name: 'Claude 4.5 achieves SOTA on SWE-bench',
        type: 'signal',
        confidence: 0.95,
        sourceUrl: 'https://www.anthropic.com/research/claude-4-5-swe-bench',
        agentName: 'creator',
      },
    ],
    sources: [
      {
        url: 'https://www.anthropic.com/research/claude-4-5-swe-bench',
        title: 'Claude 4.5 SWE-bench results',
        snippet: 'Claude 4.5 sets a new state-of-the-art on SWE-bench for autonomous software engineering.',
      },
      { url: 'https://ai.meta.com/blog/llama-4', title: 'Meta releases Llama 4' },
    ],
    result:
      'Published "State of AI 2026: Quarterly Radar Briefing" — four ring movements, the SWE-bench breakthrough as signal of the quarter, and three recommended Q3 actions.',
    skillInvocations: [
      { skill: 'generate-radar-report', firedAt: new Date(now - 170 * 60 * 1000).toISOString(), turn: 3 },
      {
        skill: 'design-pass',
        args: 'CONCEPTION brand-dark',
        firedAt: new Date(now - 160 * 60 * 1000).toISOString(),
        turn: 4,
      },
      { skill: 'grounded-fact-check', firedAt: new Date(now - 140 * 60 * 1000).toISOString(), turn: 9 },
      { skill: 'critique-report', firedAt: new Date(now - 128 * 60 * 1000).toISOString(), turn: 12 },
    ],
    slots: [
      { name: 'radar-briefing', intent: 'Quarterly radar briefing covering ring movements and Q3 recommendations' },
    ],
    designBrief: resolveDesignBrief(DEMO_USER_UID),
    qualityReport: {
      evaluatedAt: new Date(now - 120 * 60 * 1000).toISOString(),
      overallScore: 0.92,
      verdict: 'PASS',
      checks: [
        {
          name: 'answers-question',
          pass: true,
          critical: true,
          detail: 'Briefing covers all four requested ring movements and the Q3 recommendations.',
        },
        {
          name: 'evidence-cited',
          pass: true,
          critical: true,
          detail: 'Headline claims trace to the SWE-bench and agent-convergence signals.',
        },
        {
          name: 'design-brief-applied',
          pass: true,
          critical: false,
          detail: 'brand-dark palette and typography applied to the report shell.',
        },
      ],
    },
    createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    completedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    tokenUsage: { input: 48230, output: 9410 },
    costUsd: 1.84,
  },
  {
    id: 'demo-mission-rag-decision',
    kind: 'research',
    userId: DEMO_USER_UID,
    prompt:
      'Write a decision memo: when does retrieval-augmented generation beat fine-tuning, and vice versa? End with a clear recommendation for our platform team.',
    agent: 'strategist',
    status: 'completed',
    progress: 100,
    progressMessage: 'Decision memo published',
    entities: [
      {
        id: 'tech-rag-pipelines',
        name: 'RAG Pipelines',
        type: 'technology',
        confidence: 0.96,
        agentName: 'strategist',
      },
      { id: 'tech-claude-4-5', name: 'Claude 4.5', type: 'technology', confidence: 0.88, agentName: 'strategist' },
    ],
    sources: [
      {
        url: 'https://arxiv.org/abs/2026.agent-convergence',
        title: 'Agent framework convergence around tool-use standards',
      },
    ],
    result:
      'Published "RAG vs. Fine-Tuning: When Each Pattern Wins" — RAG-first with retriever/reranker fine-tuning recommended for most 2026 teams.',
    skillInvocations: [
      { skill: 'jtbd-framing', firedAt: new Date(now - 47 * 60 * 60 * 1000).toISOString(), turn: 2 },
      { skill: 'cheapest-experiment', firedAt: new Date(now - 46 * 60 * 60 * 1000).toISOString(), turn: 6 },
      {
        skill: 'write-srl-brief',
        args: 'RAG vs fine-tuning recommendation',
        firedAt: new Date(now - 45 * 60 * 60 * 1000).toISOString(),
        turn: 9,
      },
    ],
    slots: [{ name: 'decision-memo', intent: 'Decision memo comparing RAG and fine-tuning with a recommendation' }],
    designBrief: resolveDesignBrief(DEMO_USER_UID, { theme: 'brand-light' }),
    qualityReport: {
      evaluatedAt: new Date(now - 44 * 60 * 60 * 1000).toISOString(),
      overallScore: 0.74,
      verdict: 'REVISE',
      checks: [
        {
          name: 'answers-question',
          pass: true,
          critical: true,
          detail: 'Memo answers both directions of the RAG vs fine-tuning question.',
        },
        {
          name: 'recommendation-confidence-tag',
          pass: false,
          critical: false,
          detail: 'Hybrid recommendation lacks an explicit confidence tag on the final call.',
        },
        {
          name: 'evidence-cited',
          pass: true,
          critical: true,
          detail: 'Latency and example-count thresholds carry source references.',
        },
      ],
    },
    createdAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
    completedAt: new Date(now - 44 * 60 * 60 * 1000).toISOString(),
    tokenUsage: { input: 21380, output: 6120 },
    costUsd: 0.97,
  },
];

export const DEMO_AGENT_RUNS: AgentRun[] = [
  {
    id: 'run-demo-q2-briefing',
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentName: 'Creator',
    action: 'Generated the "State of AI 2026" quarterly radar briefing',
    status: 'success',
    model: 'claude-sonnet-4-6',
    tokenUsage: { input: 48230, output: 9410 },
    costUsd: 1.84,
    duration: 412_000,
    skillInvocations: DEMO_MISSIONS[0].skillInvocations,
    qualityReport: DEMO_MISSIONS[0].qualityReport,
    createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'run-demo-rag-decision',
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-rag-decision',
    agentName: 'Strategist',
    action: 'Wrote the RAG vs. fine-tuning decision memo',
    status: 'success',
    model: 'claude-sonnet-4-6',
    tokenUsage: { input: 21380, output: 6120 },
    costUsd: 0.97,
    duration: 268_000,
    skillInvocations: DEMO_MISSIONS[1].skillInvocations,
    qualityReport: DEMO_MISSIONS[1].qualityReport,
    createdAt: new Date(now - 44 * 60 * 60 * 1000).toISOString(),
  },
];

// ============================================================================
// AGENT EVENTS (LOCAL-003) — the per-run Event Log. Without these, every seeded
// run's detail page (/agents/runs/[id]) renders "No events captured yet for this
// run", so the demo shows a run's summary/cost/tokens but zero step-by-step
// agent activity. Each event is keyed to the SAME missionId its AgentRun carries
// because getEventsForRun(userId, scopeId) matches on missionId and sorts by
// `sequence` (src/lib/agent-events.ts); the run-detail page resolves the scope
// from run.missionId. Firestore-only — renders under `npm run demo` (no Neo4j).
// These are historical, so they surface on the run-detail Event Log, NOT the
// live SSE feed (whose cursor starts at page-load "now"). `data` keys match
// describeAgentEvent (src/app/agents/runs/runs-table-rows.ts): started→prompt,
// tool_call→toolName, discovery→discoveryType; thinking/completed are fixed text.
// Timestamps + sequences ascend within each run and across the two (older run
// first), matching each run's createdAt + duration.
// ============================================================================

const Q2_EVENT_BASE = now - 2 * 60 * 60 * 1000; // = run-demo-q2-briefing.createdAt
const RAG_EVENT_BASE = now - 44 * 60 * 60 * 1000; // = run-demo-rag-decision.createdAt

export const DEMO_AGENT_EVENTS: AgentEvent[] = [
  // Strategist — RAG vs. fine-tuning decision memo (run-demo-rag-decision, older)
  {
    id: 'evt-rag-1',
    type: 'agent.started',
    timestamp: new Date(RAG_EVENT_BASE).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-rag-decision',
    agentType: 'strategist',
    sequence: 101,
    data: { prompt: 'Write the RAG vs. fine-tuning decision memo' },
  },
  {
    id: 'evt-rag-2',
    type: 'agent.thinking',
    timestamp: new Date(RAG_EVENT_BASE + 20_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-rag-decision',
    agentType: 'strategist',
    sequence: 102,
    data: {},
  },
  {
    id: 'evt-rag-3',
    type: 'agent.tool_call',
    timestamp: new Date(RAG_EVENT_BASE + 80_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-rag-decision',
    agentType: 'strategist',
    sequence: 103,
    data: { toolName: 'explainConnection' },
  },
  {
    id: 'evt-rag-4',
    type: 'agent.discovery',
    timestamp: new Date(RAG_EVENT_BASE + 160_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-rag-decision',
    agentType: 'strategist',
    sequence: 104,
    data: { discoveryType: 'evidence path' },
  },
  {
    id: 'evt-rag-5',
    type: 'agent.completed',
    timestamp: new Date(RAG_EVENT_BASE + 268_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-rag-decision',
    agentType: 'strategist',
    sequence: 105,
    data: {},
  },

  // Creator — "State of AI 2026" quarterly radar briefing (run-demo-q2-briefing)
  {
    id: 'evt-q2-1',
    type: 'agent.started',
    timestamp: new Date(Q2_EVENT_BASE).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentType: 'creator',
    sequence: 201,
    data: { prompt: 'Generate the "State of AI 2026" quarterly radar briefing' },
  },
  {
    id: 'evt-q2-2',
    type: 'agent.thinking',
    timestamp: new Date(Q2_EVENT_BASE + 30_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentType: 'creator',
    sequence: 202,
    data: {},
  },
  {
    id: 'evt-q2-3',
    type: 'agent.tool_call',
    timestamp: new Date(Q2_EVENT_BASE + 90_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentType: 'creator',
    sequence: 203,
    data: { toolName: 'getRadarPlacements' },
  },
  {
    id: 'evt-q2-4',
    type: 'agent.discovery',
    timestamp: new Date(Q2_EVENT_BASE + 180_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentType: 'creator',
    sequence: 204,
    data: { discoveryType: 'ring movement' },
  },
  {
    id: 'evt-q2-5',
    type: 'agent.tool_call',
    timestamp: new Date(Q2_EVENT_BASE + 300_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentType: 'creator',
    sequence: 205,
    data: { toolName: 'getHighConfidenceAssertions' },
  },
  {
    id: 'evt-q2-6',
    type: 'agent.completed',
    timestamp: new Date(Q2_EVENT_BASE + 412_000).toISOString(),
    userId: DEMO_USER_UID,
    missionId: 'demo-mission-q2-briefing',
    agentType: 'creator',
    sequence: 206,
    data: {},
  },
];

// ============================================================================
// DEMO ARTIFACT LOOP — one completed kind:'build' evaluation mission plus the
// artifacts it publishes, so a fresh clone shows the full judgment loop:
// build mission → verdict Document → pending ProposedAssessment (in
// /triage/assessment) → pending ProposedArtifact recommendation. Shapes
// mirror the publish path in `run-build-mission.ts`; the mission is kept in
// its own array (DEMO_MISSIONS is pinned 1:1 to the seeded reports).
// ============================================================================

const EVAL_MISSION_ID = 'demo-mission-eval-agents';
const EVAL_DOCUMENT_ID = 'doc-agents-evaluation-verdict';
const EVAL_TECHNOLOGY_ID = 'tech-autonomous-agents';
const EVAL_ASSESSMENT_ID = generateAssessmentKey(EVAL_TECHNOLOGY_ID, EVAL_MISSION_ID);

/** Measured metrics from the sandbox run — shared verbatim by the verdict Document and the assessment evidence. */
const EVAL_METRICS: Array<{ name: string; value: string; command: string }> = [
  { name: 'Task resolve rate', value: '9/12 (75%)', command: 'npm run bench -- --suite maintenance-12' },
  { name: 'Median cost per resolved task', value: '$0.61', command: 'npm run bench:report -- --metric cost' },
  { name: 'Median wall-clock per task', value: '4m 12s', command: 'npm run bench:report -- --metric latency' },
  { name: 'Regression suite after agent patches', value: '212/212 passing', command: 'npm test' },
];

const EVAL_SUMMARY =
  'Hands-on verdict: an autonomous agent loop (Claude 4.5 + tool use) resolved 9 of 12 scoped repository-maintenance ' +
  'tasks end-to-end at a median $0.61 per resolved task. Failure modes concentrate in multi-file refactors. ' +
  'Recommendation: promote Autonomous Agents from Assess to Trial (TRL 6, confidence 72).';

export const DEMO_BUILD_MISSIONS: Mission[] = [
  {
    id: EVAL_MISSION_ID,
    kind: 'build',
    artifactKind: 'evaluation',
    userId: DEMO_USER_UID,
    prompt:
      'Hands-on evaluation: is the autonomous-agent stack ready for a Trial promotion? Build a sandboxed benchmark ' +
      'harness that runs a Claude 4.5 tool-use agent loop against 12 scoped repository-maintenance tasks (bug fix, ' +
      'dependency bump, test repair). Measure resolve rate, wall-clock, and cost per task, then produce a structured ' +
      'verdict with a TRL estimate and a radar-ring recommendation.',
    agent: 'evaluator',
    status: 'completed',
    progress: 100,
    progressMessage: 'Verdict published — assessment awaiting review',
    entities: [
      {
        id: EVAL_TECHNOLOGY_ID,
        name: 'Autonomous Agents',
        type: 'technology',
        confidence: 0.94,
        agentName: 'evaluator',
      },
      { id: 'tech-claude-4-5', name: 'Claude 4.5', type: 'technology', confidence: 0.88, agentName: 'evaluator' },
    ],
    sources: [
      {
        url: 'https://www.anthropic.com/engineering/building-effective-agents',
        title: 'Building effective agents',
        snippet: 'Composable tool-use loops outperform heavyweight frameworks for scoped agentic tasks.',
      },
      {
        url: 'https://arxiv.org/abs/2310.06770',
        title: 'SWE-bench: Can Language Models Resolve Real-World GitHub Issues?',
      },
    ],
    result: EVAL_SUMMARY,
    motivation: { sourceTechnologyId: EVAL_TECHNOLOGY_ID, useCaseIds: [], painPointIds: [], strategyIds: [] },
    findings: [
      {
        title: 'Proposed TRL 6 — trial (hands-on)',
        detail: `${EVAL_SUMMARY} Review and apply in /triage/assessment.`,
        kind: 'verdict',
        confidence: 72,
      },
      {
        title: 'Task resolve rate',
        detail: 'Measured via: npm run bench -- --suite maintenance-12',
        kind: 'benchmark',
        metric: '9/12 (75%)',
      },
      {
        title: 'Median cost per resolved task',
        detail: 'Measured via: npm run bench:report -- --metric cost',
        kind: 'benchmark',
        metric: '$0.61',
      },
      {
        title: 'Median wall-clock per task',
        detail: 'Measured via: npm run bench:report -- --metric latency',
        kind: 'benchmark',
        metric: '4m 12s',
      },
      {
        title: 'Unattended multi-file refactors fail',
        detail:
          'All three multi-file refactor tasks required human intervention; keep a human in the loop for structural changes.',
        kind: 'risk',
        confidence: 85,
      },
    ],
    slots: [],
    buildPhase: 'published',
    budget: { capUsd: 20, warnThreshold: 0.8, topUps: [] },
    sessions: [
      {
        index: 0,
        objective: 'Scaffold the benchmark harness and the 12-task maintenance suite across three fixture repos.',
        model: 'claude-sonnet-4-6',
        startedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
        endedAt: new Date(now - 25.4 * 60 * 60 * 1000).toISOString(),
        turns: 38,
        costUsd: 2.31,
        exitReason: 'completed',
        summary: 'Harness scaffolded; task suite and metric capture wired up.',
      },
      {
        index: 1,
        objective: 'Run the agent loop across the suite, capture metrics, and write the structured verdict.',
        model: 'claude-sonnet-4-6',
        startedAt: new Date(now - 25.3 * 60 * 60 * 1000).toISOString(),
        endedAt: new Date(now - 24.2 * 60 * 60 * 1000).toISOString(),
        turns: 51,
        costUsd: 4.11,
        exitReason: 'completed',
        summary: '12/12 tasks executed; verdict.json produced with metrics and findings.',
      },
    ],
    qaGate: { attempts: 1, verdict: 'PASS', findings: [] },
    artifact: {
      documentId: EVAL_DOCUMENT_ID,
      assessmentId: EVAL_ASSESSMENT_ID,
      publishedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    },
    createdAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
    completedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    tokenUsage: { input: 96400, output: 22310 },
    costUsd: 6.42,
  },
];

/**
 * The verdict Document published by the evaluation mission. Shape mirrors the
 * `docInput` in run-build-mission.ts — `storageUrl: ''` is the production
 * shape for verdict documents (the verdict lives in structured fields, not a
 * stored blob), so it is deliberately NOT in DEMO_DOCUMENT_BLOBS/CHUNKS.
 */
export const DEMO_BUILD_DOCUMENTS: ResearchDocument[] = [
  {
    id: EVAL_DOCUMENT_ID,
    title: 'Evaluation Verdict: Autonomous Agents (hands-on build)',
    type: 'markdown',
    storageUrl: '',
    status: 'processed',
    processedAt: now - 24 * 60 * 60 * 1000,
    description: EVAL_SUMMARY,
    aiSummary: EVAL_SUMMARY,
    tags: ['build-mission', 'evaluation', EVAL_MISSION_ID],
    mimeType: 'text/markdown',
    visibility: 'workspace',
    sourceRunId: EVAL_MISSION_ID,
    sourceMissionId: EVAL_MISSION_ID,
    structuredMetrics: EVAL_METRICS,
    createdAt: now - 24 * 60 * 60 * 1000,
    updatedAt: now - 24 * 60 * 60 * 1000,
    uploadedBy: 'build-mission',
  },
];

/**
 * The PENDING assessment staged by the evaluation publish path — visible in
 * /triage/assessment until a reviewer approves it. Confidence 72 sits below
 * the autopilot threshold, so it stays pending by design.
 */
export const DEMO_PROPOSED_ASSESSMENTS: ProposedAssessment[] = [
  {
    id: EVAL_ASSESSMENT_ID,
    technologyId: EVAL_TECHNOLOGY_ID,
    technologyName: 'Autonomous Agents',
    recommendation: 'trial',
    trl: 6,
    confidence: 72,
    evidence: {
      metrics: EVAL_METRICS,
      findings: [
        {
          title: 'Proposed TRL 6 — trial (hands-on)',
          detail: `${EVAL_SUMMARY} Review and apply in /triage/assessment.`,
          kind: 'verdict',
          confidence: 72,
        },
        {
          title: 'Unattended multi-file refactors fail',
          detail:
            'All three multi-file refactor tasks required human intervention; keep a human in the loop for structural changes.',
          kind: 'risk',
          confidence: 85,
        },
        {
          title: 'Executable feedback drives resolve rate',
          detail:
            'Tasks in repositories with runnable test suites resolved at nearly double the rate of untested ones — mirrors the SWE-bench finding.',
          kind: 'observation',
          confidence: 70,
        },
      ],
    },
    proposedRing: 'Trial',
    radarId: DEMO_RADAR.id,
    quadrantId: 'q_applied_ai',
    sourceRunId: EVAL_MISSION_ID,
    sourceDocumentId: EVAL_DOCUMENT_ID,
    status: 'pending',
    createdAt: now - 24 * 60 * 60 * 1000,
    updatedAt: now - 24 * 60 * 60 * 1000,
  },
];

/**
 * A PENDING artifact recommendation riding on the evaluation's verdict —
 * approval would EXECUTE report generation (never auto-run while pending).
 */
export const DEMO_PROPOSED_ARTIFACTS: ProposedArtifact[] = [
  {
    id: generateProposedArtifactKey(
      'report',
      'Agent Readiness Brief: from Assess to Trial',
      EVAL_TECHNOLOGY_ID,
      DEMO_USER_UID
    ),
    artifactKind: 'report',
    title: 'Agent Readiness Brief: from Assess to Trial',
    rationale:
      'The hands-on evaluation of Autonomous Agents proposes an Assess → Trial promotion. A decision-ready brief tying ' +
      'the measured resolve rate and cost-per-task to the Q3 prototype budget would close the loop for the AI-First ' +
      'strategy review.',
    matchedTopics: ['agents', 'benchmark', 'ai-first'],
    scope: {
      entityType: 'technology',
      entityIds: [EVAL_TECHNOLOGY_ID, 'tech-claude-4-5'],
      query: 'Autonomous-agent production readiness — verdict metrics and the Q3 recommendation',
    },
    params: {},
    confidence: 76,
    status: 'pending',
    generationStatus: 'idle',
    sourceRunId: EVAL_MISSION_ID,
    sourceUserId: DEMO_USER_UID,
    createdAt: now - 23 * 60 * 60 * 1000,
    updatedAt: now - 23 * 60 * 60 * 1000,
  },
];

// ============================================================================
// DEMO RESEARCH DOCUMENTS — processed Evidence-Layer documents so the
// Knowledge/Library surfaces have content. No Zod schema exists for the
// `documents` collection; the `Document` interface is the contract.
//
// Each document is REAL: its markdown content is seeded into the
// `document_blobs` Firestore-fallback store (the collection
// `adminGetDocumentContent` → `adminGetFromFirestoreFallback` reads on the
// /api/documents/download path) and split into `documentChunks` docs. The
// advertised `chunkCount` / `fileSize` are DERIVED from the content so the
// metadata stays honest.
// ============================================================================

/** Markdown content per document id — the source of truth for blobs + chunks. */
export const DEMO_DOCUMENT_CONTENTS: Record<string, string> = {
  'doc-swe-bench-analysis': `# Claude 4.5 SWE-bench Results: Verified Analysis
Anthropic's Claude 4.5 sets a new state of the art on SWE-bench, resolving 72% of real-world GitHub issues end-to-end without human intervention. The evaluation used the full SWE-bench test split with the standard harness: the model receives a repository snapshot plus the issue text and must produce a patch that passes the repository's own test suite.

## Methodology notes
Runs were executed with a tool-use loop (file browsing, editing, and test execution) capped at 60 turns per issue. Scores are averaged over three seeded runs; variance between runs stayed under 1.5 percentage points, which makes the headline number reproducible rather than a best-of sample.

## Score breakdown
Performance is strongest on bug-fix issues and weakest on multi-file feature requests. Repositories with comprehensive test coverage see materially higher resolve rates, confirming that executable feedback — not just code reading — drives most of the gain over prior models.

## Implications for agentic coding workflows
The result moves autonomous code generation from research demo to deployable surface for scoped maintenance work. Teams piloting agent-assisted development should start with well-tested codebases and bug-fix backlogs, where the verified resolve rate is highest, before expanding to feature work.
`,
  'doc-eu-ai-act-brief': `# EU AI Act: High-Risk System Compliance Brief
Enforcement of the EU AI Act has begun for high-risk AI systems. Providers deploying AI in critical sectors — employment, credit scoring, essential services, law enforcement — must now demonstrate conformity before placing systems on the EU market.

## Documentation obligations
High-risk systems require technical documentation covering intended purpose, training-data provenance, accuracy metrics, and known failure modes. The documentation must be kept current across model updates; a retrained model is treated as a substantial modification triggering re-assessment.

## Testing and human oversight
Providers must run pre-deployment testing against the declared intended purpose and maintain post-market monitoring. Human-oversight requirements mean a natural person must be able to interpret system output and intervene or halt operation — fully unattended high-risk deployment is non-compliant by construction.

## What this means for radar planning
Compliance cost now belongs in any business case for AI features that touch high-risk categories. Teams should classify each planned AI capability against the Act's annexes early; reclassifying after build is substantially more expensive than designing for the obligations up front.
`,
  'doc-rag-finetuning-research': `# Deep Research: RAG vs Fine-Tuning Cost Curves
This dossier compares the total cost of ownership of retrieval-augmented generation against fine-tuning for domain adaptation, feeding the "RAG vs. Fine-Tuning: When Each Pattern Wins" decision memo.

## Re-indexing vs re-training economics
RAG's marginal cost of knowledge change is a re-embed and re-index pass — roughly linear in changed documents and typically minutes of wall-clock time. Fine-tuning's marginal cost is a training run plus regression evaluation, paid in full even for small knowledge deltas. For corpora that change weekly, the cost curves diverge by more than an order of magnitude within a quarter.

## Latency budgets
Retrieval adds an embedding lookup and a reranking hop — around 100-300 ms on typical stacks. Fine-tuned models answer directly from weights with no retrieval round-trip. Workloads with sub-200 ms budgets are pushed toward fine-tuning; everything tolerant of 300 ms or more keeps the RAG hop affordable.

## Recommendation feed
The crossover favors RAG-first for fast-moving corpora with citation requirements, with selective fine-tuning of the retriever and reranker once query distribution stabilizes. Fine-tuning the generator only pays off for stable vocabularies with strict format-conformance or latency requirements.
`,
};

/** Look up a document's content, failing loudly on an id mismatch. */
function demoDocContent(documentId: string): string {
  const content = DEMO_DOCUMENT_CONTENTS[documentId];
  if (!content) throw new Error(`No demo content defined for document ${documentId}`);
  return content;
}

/**
 * Split markdown content into paragraph chunks with honest character offsets.
 * Mirrors the paragraph-boundary behavior of `splitTextIntoChunks` in
 * `src/lib/document-chunk-service.ts` (not imported — that module pulls in the
 * client Firebase SDK).
 */
export function splitDemoDocContent(content: string): Array<{ content: string; startChar: number; endChar: number }> {
  const chunks: Array<{ content: string; startChar: number; endChar: number }> = [];
  let cursor = 0;
  for (const part of content.split(/\n\n+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const startChar = content.indexOf(trimmed, cursor);
    const endChar = startChar + trimmed.length;
    chunks.push({ content: trimmed, startChar, endChar });
    cursor = endChar;
  }
  return chunks;
}

export const DEMO_DOCUMENTS: ResearchDocument[] = [
  {
    id: 'doc-swe-bench-analysis',
    title: 'Claude 4.5 SWE-bench Results: Verified Analysis',
    type: 'url',
    storageUrl: 'documents/demo/doc-swe-bench-analysis.md',
    originalUrl: 'https://www.anthropic.com/research/claude-4-5-swe-bench',
    domain: 'anthropic.com',
    status: 'processed',
    processedAt: now - 2 * 24 * 60 * 60 * 1000,
    chunkCount: splitDemoDocContent(demoDocContent('doc-swe-bench-analysis')).length,
    description:
      'Source analysis behind the SWE-bench signal: methodology, score breakdown, and implications for agentic coding workflows.',
    tags: ['benchmark', 'coding', 'agents'],
    fileSize: Buffer.byteLength(demoDocContent('doc-swe-bench-analysis'), 'utf8'),
    mimeType: 'text/markdown',
    createdAt: now - 3 * 24 * 60 * 60 * 1000,
    updatedAt: now - 2 * 24 * 60 * 60 * 1000,
    uploadedBy: DEMO_USER_UID,
  },
  {
    id: 'doc-eu-ai-act-brief',
    title: 'EU AI Act: High-Risk System Compliance Brief',
    // Markdown (not pdf) so the seeded blob content is genuinely downloadable —
    // a markdown body labeled application/pdf would serve a corrupt file.
    type: 'markdown',
    storageUrl: 'documents/demo/doc-eu-ai-act-brief.md',
    status: 'processed',
    processedAt: now - 5 * 24 * 60 * 60 * 1000,
    chunkCount: splitDemoDocContent(demoDocContent('doc-eu-ai-act-brief')).length,
    description:
      'Compliance brief on AI Act enforcement for high-risk systems: documentation, testing, and human-oversight obligations.',
    tags: ['regulation', 'compliance', 'eu'],
    fileSize: Buffer.byteLength(demoDocContent('doc-eu-ai-act-brief'), 'utf8'),
    mimeType: 'text/markdown',
    createdAt: now - 6 * 24 * 60 * 60 * 1000,
    updatedAt: now - 5 * 24 * 60 * 60 * 1000,
    uploadedBy: DEMO_USER_UID,
  },
  {
    id: 'doc-rag-finetuning-research',
    title: 'Deep Research: RAG vs Fine-Tuning Cost Curves',
    type: 'deep-research',
    storageUrl: 'documents/demo/doc-rag-finetuning-research.md',
    status: 'processed',
    processedAt: now - 4 * 24 * 60 * 60 * 1000,
    chunkCount: splitDemoDocContent(demoDocContent('doc-rag-finetuning-research')).length,
    description:
      'Deep-research dossier feeding the RAG vs fine-tuning decision memo: re-indexing vs re-training cost curves and latency budgets.',
    tags: ['rag', 'fine-tuning', 'cost'],
    fileSize: Buffer.byteLength(demoDocContent('doc-rag-finetuning-research'), 'utf8'),
    mimeType: 'text/markdown',
    createdAt: now - 4 * 24 * 60 * 60 * 1000,
    updatedAt: now - 4 * 24 * 60 * 60 * 1000,
    uploadedBy: DEMO_USER_UID,
  },
];

// ============================================================================
// DEMO DOCUMENT BLOBS + CHUNKS — derived from DEMO_DOCUMENT_CONTENTS.
//
// Blob doc shape mirrors `uploadToFirestoreFallback` in
// `src/lib/document-storage-service.ts` (doc id = storagePath with '/' → '_',
// base64 `content`, `mimeType`, `size`); chunk doc shape mirrors
// `chunkToFirestore` + `createVersionedChunks` in
// `src/lib/document-chunk-service.ts`. `archived: false` must be PRESENT —
// Firestore `!=` queries exclude docs missing the field, so chunks without it
// are invisible to `getActiveChunksForDocument`.
// ============================================================================

interface DemoDocumentBlob {
  /** document_blobs doc id — `storagePath.replace(/\//g, '_')`. */
  id: string;
  /** Base64-encoded markdown content. */
  content: string;
  mimeType: string;
  fileName: string;
  userId: string;
  storagePath: string;
  size: number;
  createdAt: number;
}

interface DemoDocumentChunk {
  id: string;
  documentId: string;
  content: string;
  metadata: { startChar: number; endChar: number };
  chunkIndex: number;
  tokenCount: number;
  documentVersion: number;
  archived: boolean;
  createdAt: number;
}

export const DEMO_DOCUMENT_BLOBS: DemoDocumentBlob[] = DEMO_DOCUMENTS.map((document) => {
  const content = demoDocContent(document.id);
  return {
    id: document.storageUrl.replace(/\//g, '_'),
    content: Buffer.from(content, 'utf8').toString('base64'),
    mimeType: document.mimeType ?? 'text/markdown',
    fileName: document.storageUrl.split('/').pop() ?? `${document.id}.md`,
    userId: document.uploadedBy,
    storagePath: document.storageUrl,
    size: Buffer.byteLength(content, 'utf8'),
    createdAt: document.createdAt,
  };
});

export const DEMO_DOCUMENT_CHUNKS: DemoDocumentChunk[] = DEMO_DOCUMENTS.flatMap((document) =>
  splitDemoDocContent(demoDocContent(document.id)).map((chunk, index) => ({
    id: `${document.id}-chunk-${index}`,
    documentId: document.id,
    content: chunk.content,
    metadata: { startChar: chunk.startChar, endChar: chunk.endChar },
    chunkIndex: index,
    // Same heuristic as `estimateTokenCount` (~4 chars per token).
    tokenCount: Math.ceil(chunk.content.length / 4),
    documentVersion: 1,
    archived: false,
    createdAt: document.createdAt,
  }))
);

// ============================================================================
// FIREBASE INITIALIZATION (EMULATOR ONLY)
// ============================================================================

export const COLLECTIONS_TO_CLEAR = [
  'radars',
  'technologies',
  'companies',
  'signals',
  'strategies',
  'relations',
  RELATION_TRIPLE_LOCK_COLLECTION,
  RELATION_SYNC_OUTBOX_COLLECTION,
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  'graphReconciliationCursors',
  'reports',
  'visualizations',
  ...SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS,
  'proposedRelations',
  'missions',
  'agentRuns',
  'agent-events',
  'documents',
  'document_blobs',
  'documentChunks',
  'proposedAssessments',
  'proposedArtifacts',
];

/**
 * Collections whose browser writes are intentionally denied by firestore.rules.
 * The demo seed is a trusted server-side script, so these must be cleared and
 * populated through the Admin SDK rather than weakening the client rules.
 */
export const SERVER_OWNED_SEED_COLLECTIONS: ReadonlySet<string> = new Set([
  ...SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS,
]);

function initFirestore(): ReturnType<typeof getFirestore> {
  // Fail closed before any connection: this seed batch-clears whole collections
  // (relations, relation-triple locks, and the durable relationSyncOutbox) with
  // no per-relation outbox marker or lock-ownership check, which is only ever
  // safe against a disposable local emulator (GRAPH-038). Rejects a real project
  // id or an explicit non-loopback emulator host.
  const projectId = getScriptFirebaseProjectId();
  assertDisposableFirestoreResetTarget(projectId);

  // The remaining fields are intentional emulator placeholders — the emulator
  // only routes by projectId.
  const firebaseConfig = {
    projectId,
    appId: 'demo-app',
    storageBucket: 'demo-bucket',
    apiKey: 'demo-key',
    authDomain: 'demo.firebaseapp.com',
  };

  // Use a NAMED app, not the [DEFAULT] one. A transitively-loaded module
  // (e.g. `@/lib/firebase`) may already have initialized the default app with
  // real-project config; calling initializeApp() again throws
  // `app/duplicate-app`, and reusing that default app would seed to the wrong
  // project. A dedicated named app is isolated and idempotent across re-runs.
  const SEED_APP_NAME = 'radarist-demo-seed';
  const app = getApps().some((a) => a.name === SEED_APP_NAME)
    ? getApp(SEED_APP_NAME)
    : initializeApp(firebaseConfig, SEED_APP_NAME);
  const db = getFirestore(app);
  const emulator = parseEmulatorHost(process.env.FIRESTORE_EMULATOR_HOST, DEFAULT_FIREBASE_EMULATOR_HOSTS.firestore);

  try {
    connectFirestoreEmulator(db, emulator.host, emulator.port);
    console.log(`[Demo Seed] Connected to Firestore emulator at ${emulator.host}:${emulator.port}`);
  } catch (error) {
    console.error('[Demo Seed] Failed to connect to emulator:', error);
    process.exit(1);
  }

  return db;
}

async function initAdminFirestore(): Promise<AdminFirestore> {
  const projectId = getScriptFirebaseProjectId();
  assertDisposableFirestoreResetTarget(projectId);

  // Admin SDK routing is environment-driven. Match the same verified loopback
  // endpoint used by the Web SDK and normalize URL-form inputs to host:port.
  const emulator = parseEmulatorHost(process.env.FIRESTORE_EMULATOR_HOST, DEFAULT_FIREBASE_EMULATOR_HOSTS.firestore);
  process.env.FIRESTORE_EMULATOR_HOST = formatHostPort(emulator);

  const [{ getApps: getAdminApps, initializeApp: initializeAdminApp }, { getFirestore: getAdminFirestore }] =
    await Promise.all([import('firebase-admin/app'), import('firebase-admin/firestore')]);
  const appName = 'radarist-demo-seed-admin';
  const app =
    getAdminApps().find((candidate) => candidate.name === appName) ?? initializeAdminApp({ projectId }, appName);
  return getAdminFirestore(app);
}

// ============================================================================
// SEEDING FUNCTIONS
// ============================================================================

/**
 * Clears all documents from a collection.
 */
async function clearCollection(db: ReturnType<typeof getFirestore>, collectionName: string): Promise<number> {
  const snapshot = await getDocs(collection(db, collectionName));
  const batch = writeBatch(db);
  let count = 0;

  snapshot.docs.forEach((document) => {
    batch.delete(document.ref);
    count++;
  });

  if (count > 0) {
    await batch.commit();
  }

  return count;
}

/**
 * Clears all seeded collections.
 */
async function clearCollections(db: ReturnType<typeof getFirestore>, adminDb: AdminFirestore): Promise<void> {
  console.log('[Demo Seed] Clearing existing data...');
  for (const collectionName of COLLECTIONS_TO_CLEAR) {
    const count = SERVER_OWNED_SEED_COLLECTIONS.has(collectionName)
      ? await clearServerOwnedRadarPlacementCollection(
          adminDb,
          collectionName as (typeof SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS)[number]
        )
      : await clearCollection(db, collectionName);
    if (count > 0) {
      console.log(`  Cleared ${count} documents from ${collectionName}`);
    }
  }
}

/**
 * Seeds the radar.
 */
async function seedRadars(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding radar...');
  const batch = writeBatch(db);
  batch.set(doc(db, 'radars', DEMO_RADAR.id), DEMO_RADAR);
  await batch.commit();
  console.log(`  Created radar: ${DEMO_RADAR.name}`);
}

/**
 * Seeds technologies.
 */
async function seedTechnologies(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding technologies...');
  const batch = writeBatch(db);
  for (const tech of DEMO_TECHNOLOGIES) {
    batch.set(doc(db, 'technologies', tech.id), tech);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_TECHNOLOGIES.length} technologies`);
}

/**
 * Seeds companies.
 */
async function seedCompanies(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding companies...');
  const batch = writeBatch(db);
  for (const company of DEMO_COMPANIES) {
    batch.set(doc(db, 'companies', company.id), company);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_COMPANIES.length} companies`);
}

/**
 * Seeds signals.
 */
async function seedSignals(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding signals...');
  const batch = writeBatch(db);
  for (const signal of DEMO_SIGNALS) {
    batch.set(doc(db, 'signals', signal.id), signal);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_SIGNALS.length} signals`);
}

/**
 * Seeds strategies.
 */
async function seedStrategies(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding strategies...');
  const batch = writeBatch(db);
  for (const strategy of DEMO_STRATEGIES) {
    batch.set(doc(db, 'strategies', strategy.id), strategy);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_STRATEGIES.length} strategies`);
}

/**
 * Seeds relations.
 */
async function seedRelations(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding relations...');
  const batch = writeBatch(db);
  for (const relation of DEMO_RELATION_DOCUMENTS) {
    batch.set(doc(db, 'relations', relation.id), relation);
  }
  for (const lock of DEMO_RELATION_TRIPLE_LOCKS) {
    batch.set(doc(db, RELATION_TRIPLE_LOCK_COLLECTION, lock.id), lock.data);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_RELATIONS.length} relations + deterministic triple locks`);
}

async function seedReports(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding reports...');
  const batch = writeBatch(db);
  for (const report of DEMO_REPORTS) {
    // REPORT-013 — the demo writes straight to Firestore, so it used to skip the
    // publication boundary every agent-authored report must clear. That let the
    // showcase model an output shape (linked https references) the product's own
    // publish path rejects. Seeded HTML now clears the same two gates.
    assertPublishableReportHtml(report.html);
    assertReportReferenceIntegrity(report.html);
    batch.set(doc(db, 'reports', report.id), report);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_REPORTS.length} reports`);
}

async function seedVisualizations(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding visualizations...');
  const batch = writeBatch(db);
  for (const viz of DEMO_VISUALIZATIONS) {
    batch.set(doc(db, 'visualizations', viz.id), viz);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_VISUALIZATIONS.length} visualizations`);
}

/**
 * Seeds radar placements (decoupled Technology + RadarPlacement model).
 * Each doc is validated against the placement Zod schema before write.
 */
export async function seedRadarPlacements(db: AdminFirestore): Promise<void> {
  console.log('[Demo Seed] Seeding radar placements...');
  const placements = DEMO_RADAR_PLACEMENTS.map((placement) => demoRadarPlacementSchema.parse(placement));
  await seedRadarPlacementsWithAdmin(db, placements);
  console.log(`  Created ${DEMO_RADAR_PLACEMENTS.length} radar placements (+ pair locks)`);
}

/**
 * Seeds pending proposed relations for the Linker Triage page.
 * No Zod schema exists for proposedRelations — the `ProposedRelation`
 * type (compile-time) is the contract, matching seed-emulator.ts.
 */
async function seedProposedRelations(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding proposed relations...');
  const batch = writeBatch(db);
  for (const proposal of DEMO_PROPOSED_RELATIONS) {
    batch.set(doc(db, 'proposedRelations', proposal.id), proposal);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_PROPOSED_RELATIONS.length} proposed relations`);
}

/**
 * Seeds completed missions: the research missions backing the seeded reports
 * plus the build (evaluation) mission backing the artifact loop.
 * Each doc is validated against missionSchema before write.
 */
async function seedMissions(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding missions...');
  const batch = writeBatch(db);
  for (const mission of [...DEMO_MISSIONS, ...DEMO_BUILD_MISSIONS]) {
    batch.set(doc(db, 'missions', mission.id), missionSchema.parse(mission));
  }
  await batch.commit();
  console.log(`  Created ${DEMO_MISSIONS.length + DEMO_BUILD_MISSIONS.length} missions`);
}

/**
 * Seeds agent runs mirroring the seeded missions (Activity page).
 * Each doc is validated against agentRunSchema before write.
 */
async function seedAgentRuns(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding agent runs...');
  const batch = writeBatch(db);
  for (const run of DEMO_AGENT_RUNS) {
    batch.set(doc(db, 'agentRuns', run.id), agentRunSchema.parse(run));
  }
  await batch.commit();
  console.log(`  Created ${DEMO_AGENT_RUNS.length} agent runs`);
}

async function seedAgentEvents(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding agent events...');
  const batch = writeBatch(db);
  for (const event of DEMO_AGENT_EVENTS) {
    batch.set(doc(db, 'agent-events', event.id), agentEventSchema.parse(event));
  }
  await batch.commit();
  console.log(`  Created ${DEMO_AGENT_EVENTS.length} agent events`);
}

/**
 * Seeds the pending assessment staged by the evaluation build mission
 * (the /triage/assessment lane). Validated against proposedAssessmentSchema.
 */
async function seedProposedAssessments(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding proposed assessments...');
  const batch = writeBatch(db);
  for (const assessment of DEMO_PROPOSED_ASSESSMENTS) {
    batch.set(doc(db, 'proposedAssessments', assessment.id), proposedAssessmentSchema.parse(assessment));
  }
  await batch.commit();
  console.log(`  Created ${DEMO_PROPOSED_ASSESSMENTS.length} proposed assessments`);
}

/**
 * Seeds the pending artifact recommendation (Assessments inbox). Validated
 * against proposedArtifactSchema.
 */
async function seedProposedArtifacts(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding proposed artifacts...');
  const batch = writeBatch(db);
  for (const artifact of DEMO_PROPOSED_ARTIFACTS) {
    batch.set(doc(db, 'proposedArtifacts', artifact.id), proposedArtifactSchema.parse(artifact));
  }
  await batch.commit();
  console.log(`  Created ${DEMO_PROPOSED_ARTIFACTS.length} proposed artifacts`);
}

/**
 * Seeds processed research documents (Evidence Layer / Knowledge tab) plus
 * the build-mission verdict document (no blob — structured fields only).
 * No Zod schema exists for documents — the `Document` type is the contract.
 */
async function seedDocuments(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding documents...');
  const batch = writeBatch(db);
  for (const document of [...DEMO_DOCUMENTS, ...DEMO_BUILD_DOCUMENTS]) {
    batch.set(doc(db, 'documents', document.id), document);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_DOCUMENTS.length + DEMO_BUILD_DOCUMENTS.length} documents`);
}

/**
 * Seeds the Firestore-fallback content blobs backing the demo documents, so
 * the /api/documents/download path serves real content.
 */
async function seedDocumentBlobs(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding document content blobs...');
  const batch = writeBatch(db);
  for (const blob of DEMO_DOCUMENT_BLOBS) {
    const { id, ...data } = blob;
    batch.set(doc(db, 'document_blobs', id), data);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_DOCUMENT_BLOBS.length} document content blobs`);
}

/**
 * Seeds the documentChunks extracted from the demo document contents, so the
 * Evidence-Layer chunk readers (and each document's advertised chunkCount)
 * are backed by real data.
 */
async function seedDocumentChunks(db: ReturnType<typeof getFirestore>): Promise<void> {
  console.log('[Demo Seed] Seeding document chunks...');
  const batch = writeBatch(db);
  for (const chunk of DEMO_DOCUMENT_CHUNKS) {
    const { id, ...data } = chunk;
    batch.set(doc(db, 'documentChunks', id), data);
  }
  await batch.commit();
  console.log(`  Created ${DEMO_DOCUMENT_CHUNKS.length} document chunks`);
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

/** LOCAL-003 preference topics — meaningfulTags-shaped so they intersect the seeded technology tags (rag → tech-rag-pipelines, agents → tech-autonomous-agents, inference → tech-vllm). */
export const DEMO_PREFERENCE_TOPICS = ['rag', 'agents', 'inference'];

/** LOCAL-003 session exploration — seeded technology ids the demo user "explored" (the EXPLORED edges + the "you explored X" half of the connection insight). */
export const DEMO_SESSION_EXPLORED_IDS = ['tech-vllm', 'tech-rag-pipelines', 'tech-claude-4-5'];

/**
 * A seeded `/triage/insights` card. `confidence` is a 0–1 fraction (read gate is
 * `>= 0.4`), NOT the 0–100 relation-confidence scale. When `connection` is set,
 * the insight is `type: 'connection'` and carries the structured path fields
 * (relationshipTypes/pathLength/observed/explored) that render the "because you
 * explored X" WhyAmISeeingThis card; `entityId` is the observed subject.
 */
export interface DemoInsightSeed {
  id: string;
  type: 'discovery' | 'scoring_change' | 'connection';
  entityId: string;
  title: string;
  summary: string;
  agentName: string;
  confidence: number;
  connection?: { exploredId: string; relationshipTypes: string[]; pathLength: number };
}

/** LOCAL-003 proactive insights — two simple cards + one structured connection card. */
export const DEMO_PROACTIVE_INSIGHTS: DemoInsightSeed[] = [
  {
    id: 'demo-insight-small-models-discovery',
    type: 'discovery',
    entityId: 'tech-fine-tuned-small-models',
    title: 'Fine-tuned small models are closing the gap',
    agentName: 'scout',
    confidence: 0.84,
    summary:
      'Fine-tuned sub-10B models are matching frontier quality on narrow tasks at a fraction of the cost — worth a fresh look before the next radar review.',
  },
  {
    id: 'demo-insight-rag-scoring',
    type: 'scoring_change',
    entityId: 'tech-rag-pipelines',
    title: 'RAG Pipelines moved toward Adopt',
    agentName: 'evaluator',
    confidence: 0.78,
    summary:
      'Corroborating evidence from two independent sources nudged RAG Pipelines’ effective confidence up; consider promoting it from Trial to Adopt.',
  },
  {
    id: 'demo-insight-agents-rag-connection',
    type: 'connection',
    entityId: 'tech-autonomous-agents',
    title: 'Autonomous Agents connect to RAG Pipelines you explored',
    agentName: 'scout',
    confidence: 0.9,
    summary:
      'Your scout agent surfaced Autonomous Agents (technology), 1 hop from RAG Pipelines that you explored earlier. The connection runs through: USES — agent frameworks increasingly ground their reasoning in RAG retrieval.',
    connection: { exploredId: 'tech-rag-pipelines', relationshipTypes: ['USES'], pathLength: 1 },
  },
];

/**
 * LOCAL-003: seed the Neo4j-native representative state that the graph-backed UI
 * reads but which has no Firestore backing — user preferences, session /
 * exploration history, and proactive insights (including one structured "because
 * you explored X" connection card). Because these are Neo4j-only they render
 * ONLY under `npm run demo:full` (Neo4j up), never plain `npm run demo`.
 *
 * Runs AFTER the entity/relation sync so the `:Entity` nodes the `:ABOUT` /
 * `:EXPLORED` edges attach to already exist. Idempotent (deterministic ids +
 * MERGE) and best-effort — a failure here never fails the Firestore seed.
 *
 * SCALE TRAP: proactive-insight `confidenceScore` and observation `confidence`
 * are 0–1 fractions here (read gate is `>= 0.4`), NOT the 0–100 relation
 * confidence scale — see src/lib/graph/proactive-insights.ts.
 */
async function seedNeo4jRepresentativeState(): Promise<void> {
  const nowIso = new Date(now).toISOString();
  const exploredAtIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // 1. USER PREFERENCES — headless topic weights that personalize discovery and
  //    insight ranking. Idempotent MERGE keyed on {userId, topic}; seedActedCount
  //    3 → weight 1.0.
  for (const topic of DEMO_PREFERENCE_TOPICS) {
    await seedPreferenceWeight(DEMO_USER_UID, topic, 3);
  }

  // 2. SESSION STATE — a browsing session + EXPLORED edges over real seeded
  //    entities. Feeds the InterestProfile and the (owner-only) MCP sessions
  //    resource, and is the "you explored X" half of the connection insight.
  await runWriteTransaction(
    `MERGE (s:Session { id: $sessionId })
     ON CREATE SET s.userId = $userId, s.startedAt = $startedAt`,
    { sessionId: 'demo-session-1', userId: DEMO_USER_UID, startedAt: exploredAtIso }
  );
  for (const entityId of DEMO_SESSION_EXPLORED_IDS) {
    await runWriteTransaction(
      `MATCH (s:Session { id: $sessionId })
       MATCH (e:Entity { id: $entityId })
       MERGE (s)-[r:EXPLORED]->(e)
       ON CREATE SET r.firstViewedAt = $ts, r.viewCount = 2, r.entityType = 'technology'
       SET r.lastViewedAt = $ts`,
      { sessionId: 'demo-session-1', entityId, ts: exploredAtIso }
    );
  }

  // 3. PROACTIVE INSIGHTS — the /triage/insights inbox (empty on a fresh seed
  //    until now). Direct MERGE on a deterministic id so re-seeds are no-ops;
  //    `consumed` is set only ON CREATE so a dismissed card is not resurfaced.
  //    actionUrl is derived via getInsightAction so it passes the '<> /library'
  //    read gate and the click-through resolves. A `connection` insight also gets
  //    a paired AgentObservation (the observation substrate) and the structured
  //    path fields WhyAmISeeingThis renders — the live graph path is not required
  //    because the card reads those fields off the node itself.
  for (const insight of DEMO_PROACTIVE_INSIGHTS) {
    const action = getInsightAction('technology', insight.entityId);
    if (!insight.connection) {
      await runWriteTransaction(
        `MERGE (pi:ProactiveInsight { id: $id })
         ON CREATE SET pi.consumed = false, pi.createdAt = $createdAt
         SET pi.userId = $userId, pi.type = $type, pi.title = $title, pi.summary = $summary,
             pi.agentName = $agentName, pi.confidenceScore = $confidence, pi.actionable = true,
             pi.actionUrl = $actionUrl, pi.actionLabel = $actionLabel
         WITH pi
         MATCH (e:Entity { id: $entityId })
         MERGE (pi)-[:ABOUT]->(e)`,
        {
          id: insight.id,
          userId: DEMO_USER_UID,
          type: insight.type,
          title: insight.title,
          summary: insight.summary,
          agentName: insight.agentName,
          confidence: insight.confidence,
          actionUrl: action.actionUrl,
          actionLabel: action.actionLabel,
          createdAt: nowIso,
          entityId: insight.entityId,
        }
      );
      continue;
    }

    const observedName = DEMO_TECHNOLOGIES.find((t) => t.id === insight.entityId)?.name ?? insight.entityId;
    await runWriteTransaction(
      `MATCH (e:Entity { id: $observedId })
       MERGE (o:AgentObservation { id: $obsId })
       ON CREATE SET o.agentType = 'scout', o.observationType = 'connection', o.title = $obsTitle,
                     o.summary = $obsSummary, o.confidence = 0.8, o.entityId = $observedId,
                     o.entityName = $observedName, o.entityType = 'technology', o.timestamp = $ts
       MERGE (o)-[:ABOUT]->(e)`,
      {
        observedId: insight.entityId,
        obsId: `demo-obs-${insight.entityId}`,
        obsTitle: `${observedName} keeps surfacing near your interests`,
        obsSummary: `Scout observed rising activity around ${observedName} adjacent to what you explored.`,
        observedName,
        ts: exploredAtIso,
      }
    );
    await runWriteTransaction(
      `MERGE (pi:ProactiveInsight { id: $id })
       ON CREATE SET pi.consumed = false, pi.createdAt = $createdAt
       SET pi.userId = $userId, pi.type = 'connection', pi.observedEntityId = $observedId,
           pi.exploredEntityId = $exploredId, pi.title = $title, pi.summary = $summary,
           pi.agentName = $agentName, pi.confidenceScore = $confidence, pi.actionable = true,
           pi.actionUrl = $actionUrl, pi.actionLabel = $actionLabel, pi.relationshipTypes = $relTypes,
           pi.pathLength = $pathLength, pi.exploredAt = $exploredAt
       WITH pi
       MATCH (obs:Entity { id: $observedId })
       MATCH (exp:Entity { id: $exploredId })
       MERGE (pi)-[:ABOUT]->(obs)
       MERGE (pi)-[:ABOUT]->(exp)`,
      {
        id: insight.id,
        userId: DEMO_USER_UID,
        createdAt: nowIso,
        observedId: insight.entityId,
        exploredId: insight.connection.exploredId,
        title: insight.title,
        summary: insight.summary,
        agentName: insight.agentName,
        confidence: insight.confidence,
        actionUrl: action.actionUrl,
        actionLabel: action.actionLabel,
        relTypes: insight.connection.relationshipTypes,
        pathLength: insight.connection.pathLength,
        exploredAt: exploredAtIso,
      }
    );
  }

  const connectionCount = DEMO_PROACTIVE_INSIGHTS.filter((i) => i.connection).length;
  console.log(
    `  Seeded Neo4j representative state: ${DEMO_PREFERENCE_TOPICS.length} preferences, ` +
      `1 session + ${DEMO_SESSION_EXPLORED_IDS.length} explored, ` +
      `${DEMO_PROACTIVE_INSIGHTS.length} insights (${connectionCount} connection)`
  );
}

/**
 * Mirrors the seeded Firestore content into Neo4j so the graph-backed UI has
 * data on a fresh OSS clone. Same rationale as in `seed-emulator.ts` — raw
 * `batch.set` writes bypass `createRelation` → `entity-factory` → Inngest,
 * leaving Neo4j empty. Best-effort: skip unless the server runtime explicitly
 * resolves to a configured Neo4j target. The disabled mode is authoritative
 * even when `.env.local` contains a retained/default-port URI.
 */
export async function syncDemoToNeo4j(): Promise<void> {
  console.log('[Demo Seed] Syncing to Neo4j...');

  const graphRuntime = resolveGraphRuntime();
  if (graphRuntime.mode !== 'neo4j') {
    console.warn(
      `  [warn]Neo4j runtime is ${graphRuntime.mode} — skipping graph sync. ` +
        'Neo4j-only traversal and analytics will be unavailable.'
    );
    return;
  }

  const entities: SeedEntity[] = [
    ...DEMO_TECHNOLOGIES.map((t) => ({
      id: t.id,
      type: 'technology' as const,
      name: t.name,
      properties: {
        description: t.description,
        quadrantId: t.quadrantId,
        ring: t.ring,
        status: t.status,
        tags: t.tags,
      },
    })),
    ...DEMO_COMPANIES.map((c) => ({
      id: c.id,
      type: 'company' as const,
      name: c.name,
      properties: { description: c.description ?? '' },
    })),
    ...DEMO_SIGNALS.map((s) => ({
      id: s.id,
      type: 'signal' as const,
      name: s.title,
      properties: { description: s.description ?? '', status: s.status },
    })),
    ...DEMO_STRATEGIES.map((s) => ({
      id: s.id,
      type: 'strategy' as const,
      name: s.name,
      properties: { description: s.description ?? '' },
    })),
  ];

  // DemoRelation flattens source/target id+type onto the top level and only
  // keeps the name in `*Snapshot`. Reassemble the canonical shape the helper
  // expects (matches the production Relation type).
  const relations: SeedRelation[] = DEMO_RELATIONS.map((r) => ({
    id: r.id,
    relationType: r.relationType,
    sourceSnapshot: { id: r.sourceId, type: r.sourceType, name: r.sourceSnapshot.name },
    targetSnapshot: { id: r.targetId, type: r.targetType, name: r.targetSnapshot.name },
    // Task 16 (A1): DemoRelation.confidence is now already on the 0-100
    // scale (matches Relation.confidence + the Relation Write Contract), so
    // this is a straight passthrough — no more ×100 scaling. Kept as an
    // explicit field (not a spread) so a future scale drift shows up as a
    // one-line diff here instead of silently reintroducing a mismatch.
    confidence: r.confidence,
    // Evidence-bearing relations are agent-asserted (assertedBy:
    // 'agent:linker') so the chat assistant's ✓✓ "Corroborated" claim chip
    // has something genuine to render; the rest stay curated (assertedBy:
    // 'user:system') per the demo narrative.
    aiSuggested: r.aiSuggested ?? false,
    evidence: r.evidence,
  }));

  try {
    const result = await syncSeedToNeo4j({ entities, relations });
    console.log(`  Synced ${result.entities.synced}/${result.entities.selected} eligible entities to Neo4j`);
    if (result.entities.excludedSignals > 0) {
      console.log(`  Kept ${result.entities.excludedSignals} inbox-only Signal(s) out of Neo4j`);
    }
    console.log(
      `  Synced ${result.relations.asserted + result.relations.edged}/${relations.length} relations ` +
        `(${result.relations.asserted} via :Assertion, ${result.relations.edged} direct edges)`
    );
    if (result.entities.failed > 0 || result.relations.failed > 0) {
      console.warn(`  [warn]${result.entities.failed} entity + ${result.relations.failed} relation sync(s) failed`);
      for (const f of [...result.entities.failures, ...result.relations.failures].slice(0, 5)) {
        console.warn(`    - ${f.id}: ${f.error}`);
      }
    }
  } catch (err) {
    console.warn('  [warn]Neo4j sync failed:', err instanceof Error ? err.message : String(err));
    console.warn('  Firestore seed is intact; graph-backed UI will be empty until sync runs.');
  }

  // LOCAL-003: Neo4j-native representative state (preferences, session history,
  // proactive insights). Separate best-effort block so an entity/relation sync
  // failure above still lets this run — and vice-versa. Requires the :Entity
  // nodes synced above, so it runs last.
  try {
    await seedNeo4jRepresentativeState();
  } catch (err) {
    console.warn('  [warn]Neo4j representative-state seed failed:', err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Radarist Demo Seed - "State of AI 2026"');
  console.log('='.repeat(60));
  console.log('');

  const db = initFirestore();
  const adminDb = await initAdminFirestore();

  try {
    await clearCollections(db, adminDb);
    console.log('');

    await seedRadars(db);
    await seedTechnologies(db);
    await seedCompanies(db);
    await seedSignals(db);
    await seedStrategies(db);
    await seedRelations(db);
    await seedReports(db);
    await seedVisualizations(db);
    await seedRadarPlacements(adminDb);
    await seedProposedRelations(db);
    await seedMissions(db);
    await seedAgentRuns(db);
    await seedAgentEvents(db);
    await seedProposedAssessments(db);
    await seedProposedArtifacts(db);
    await seedDocuments(db);
    await seedDocumentBlobs(db);
    await seedDocumentChunks(db);

    // Bootstrap Neo4j from the seeded Firestore content. Without this, the
    // graph-backed UI is empty on a fresh OSS clone (raw `batch.set` writes
    // bypass the entity-factory → Inngest sync chain).
    console.log('');
    await syncDemoToNeo4j();

    const totalEntities =
      1 +
      DEMO_TECHNOLOGIES.length +
      DEMO_COMPANIES.length +
      DEMO_SIGNALS.length +
      DEMO_STRATEGIES.length +
      DEMO_RELATIONS.length +
      DEMO_REPORTS.length +
      DEMO_VISUALIZATIONS.length +
      DEMO_RADAR_PLACEMENTS.length +
      DEMO_PROPOSED_RELATIONS.length +
      DEMO_MISSIONS.length +
      DEMO_BUILD_MISSIONS.length +
      DEMO_AGENT_RUNS.length +
      DEMO_AGENT_EVENTS.length +
      DEMO_PROPOSED_ASSESSMENTS.length +
      DEMO_PROPOSED_ARTIFACTS.length +
      DEMO_DOCUMENTS.length +
      DEMO_BUILD_DOCUMENTS.length +
      DEMO_DOCUMENT_BLOBS.length +
      DEMO_DOCUMENT_CHUNKS.length;

    console.log('');
    console.log('='.repeat(60));
    console.log('Demo seed completed successfully!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Summary:');
    console.log(`  - 1 radar: ${DEMO_RADAR.name}`);
    console.log(`  - ${DEMO_TECHNOLOGIES.length} technologies across 4 quadrants`);
    console.log(`  - ${DEMO_COMPANIES.length} companies`);
    console.log(`  - ${DEMO_SIGNALS.length} signals`);
    console.log(`  - ${DEMO_STRATEGIES.length} strategies`);
    console.log(`  - ${DEMO_RELATIONS.length} relations`);
    console.log(`  - ${DEMO_RADAR_PLACEMENTS.length} radar placements`);
    console.log(`  - ${DEMO_PROPOSED_RELATIONS.length} proposed relations (for Linker Triage)`);
    console.log(
      `  - ${DEMO_MISSIONS.length + DEMO_BUILD_MISSIONS.length} missions ` +
        `(${DEMO_BUILD_MISSIONS.length} build/evaluation) + ${DEMO_AGENT_RUNS.length} agent runs ` +
        `+ ${DEMO_AGENT_EVENTS.length} agent events (per-run Event Log)`
    );
    console.log(
      `  - ${DEMO_PROPOSED_ASSESSMENTS.length} proposed assessment + ` +
        `${DEMO_PROPOSED_ARTIFACTS.length} proposed artifact (pending triage)`
    );
    console.log(
      `  - ${DEMO_DOCUMENTS.length} research documents (${DEMO_DOCUMENT_BLOBS.length} content blobs, ` +
        `${DEMO_DOCUMENT_CHUNKS.length} chunks) + ${DEMO_BUILD_DOCUMENTS.length} verdict document`
    );
    console.log(`  Total: ${totalEntities} entities across ${COLLECTIONS_TO_CLEAR.length} collections`);
    console.log('');
    console.log(
      `[Demo Seed] Done! Seeded ${totalEntities} entities across ${COLLECTIONS_TO_CLEAR.length} collections.`
    );
    console.log('');
    console.log('You can now browse the data at http://127.0.0.1:4000/firestore');
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('Demo seed failed!');
    console.error('='.repeat(60));
    console.error(error);
    process.exit(1);
  }
}

// Only run when executed directly
if (require.main === module) {
  main().catch(console.error);
}
