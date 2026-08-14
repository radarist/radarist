#!/usr/bin/env npx tsx
/**
 * @file seed-emulator.ts
 * @description Seeds the Firestore emulator with comprehensive test data.
 *
 * This script creates realistic seed data for all entity types in the Innovation Brain platform:
 * - Radars with technologies (entries)
 * - Companies (vendors, partners, startups)
 * - Strategies with directives
 * - Use cases
 * - Prototypes
 * - Signals (detected, validated, approved)
 * - Relations between entities
 *
 * Usage:
 *   1. Start the Firebase emulator: npm run firebase:emulators
 *   2. Run this script: npx tsx scripts/seed-emulator.ts
 *
 * The script is idempotent - it clears existing data before seeding.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

// MUST be the first import: loads .env.local into process.env so downstream
// modules (firebase, neo4j-client) see NEO4J_URI / NEO4J_PASSWORD /
// FIREBASE_PROJECT_ID at init time. Static imports hoist above body-level
// dotenv.config(), so this side-effect import is the only safe pattern.
import './load-env-local';

import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  writeBatch,
} from 'firebase/firestore';
import { DEFAULT_FIREBASE_EMULATOR_HOSTS, parseEmulatorHost } from '@/lib/firebase-emulator-config';
import { DEFAULT_SIGNAL_SOURCES } from '@/lib/signal-source-defaults';
// Canonical collection names — seed writes/clears the SAME collection the app
// services read. Using the literal 'useCases' here (vs the factory's
// 'use-cases') made every seeded use case invisible to the Use Cases library.
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { buildRelationTripleLockEntry, RELATION_TRIPLE_LOCK_COLLECTION } from '@/lib/relations-triple-key';
import { RELATION_SYNC_OUTBOX_COLLECTION } from '@/lib/relation-sync-outbox';
import { ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION } from '@/lib/entity-graph-sync-outbox';
import { getScriptFirebaseProjectId } from './lib/firebase-config';
import { assertDisposableFirestoreResetTarget } from './lib/disposable-firestore-target';
import { syncSeedToNeo4j, type SeedEntity, type SeedRelation } from './lib/seed-graph-sync';

// ============================================================================
// FIREBASE INITIALIZATION (EMULATOR ONLY)
// ============================================================================

// projectId comes from env (NEXT_PUBLIC_FIREBASE_PROJECT_ID); the remaining
// fields are intentional emulator placeholders — the emulator only routes by
// projectId.
const firebaseConfig = {
  projectId: getScriptFirebaseProjectId(),
  appId: 'demo-app',
  storageBucket: 'demo-bucket',
  apiKey: 'demo-key',
  authDomain: 'demo.firebaseapp.com',
};

// Named app (not [DEFAULT]) — avoids `app/duplicate-app` when a transitively
// loaded module has already initialized the default app, and prevents seeding
// to the wrong project by reusing it. Idempotent across re-runs.
const SEED_APP_NAME = 'radarist-emulator-seed';
const app = getApps().some((a) => a.name === SEED_APP_NAME)
  ? getApp(SEED_APP_NAME)
  : initializeApp(firebaseConfig, SEED_APP_NAME);
const db = getFirestore(app);
const firestoreEmulator = parseEmulatorHost(
  process.env.FIRESTORE_EMULATOR_HOST,
  DEFAULT_FIREBASE_EMULATOR_HOSTS.firestore
);

// Connect to emulator
try {
  connectFirestoreEmulator(db, firestoreEmulator.host, firestoreEmulator.port);
  console.log(`[Seed] Connected to Firestore emulator at ${firestoreEmulator.host}:${firestoreEmulator.port}`);
} catch (error) {
  console.error('[Seed] Failed to connect to emulator:', error);
  process.exit(1);
}

// ============================================================================
// SEED DATA DEFINITIONS
// ============================================================================

const now = Date.now();

/**
 * Radars - Technology radar definitions
 */
const RADARS = [
  {
    id: 'innovation-radar',
    name: 'Innovation Radar 2025',
    quadrants: ['Techniques', 'Tools', 'Platforms', 'Languages & Frameworks'],
    entries: [],
    ringSystem: 'Standard',
  },
  {
    id: 'nutrition-bu',
    name: 'Nutrition Business Unit',
    quadrants: ['AI & ML', 'Sustainability', 'Processing', 'Packaging'],
    entries: [],
    ringSystem: 'Standard',
  },
];

/**
 * Technologies (Radar Entries)
 */
const TECHNOLOGIES: Record<
  string,
  Array<{
    id: number;
    name: string;
    description: string;
    quadrant: string;
    ring: string;
    status: string;
    tags: string[];
    costToPrototype: number;
    moved: number;
  }>
> = {
  'innovation-radar': [
    {
      id: 1,
      name: 'Large Language Models',
      description: 'Foundation models like GPT-4, Claude, and Gemini for text generation and reasoning tasks.',
      quadrant: 'Techniques',
      ring: 'Adopt',
      status: 'Trending',
      tags: ['ai', 'nlp', 'generative-ai'],
      costToPrototype: 30,
      moved: 1,
    },
    {
      id: 2,
      name: 'Vector Databases',
      description: 'Specialized databases for storing and querying high-dimensional vectors for AI applications.',
      quadrant: 'Tools',
      ring: 'Trial',
      status: 'Trending',
      tags: ['database', 'ai', 'embeddings'],
      costToPrototype: 40,
      moved: 1,
    },
    {
      id: 3,
      name: 'Kubernetes',
      description: 'Container orchestration platform for deploying and managing containerized applications.',
      quadrant: 'Platforms',
      ring: 'Adopt',
      status: 'Stable',
      tags: ['devops', 'containers', 'cloud'],
      costToPrototype: 50,
      moved: 0,
    },
    {
      id: 4,
      name: 'Rust',
      description: 'Systems programming language focused on safety, performance, and concurrency.',
      quadrant: 'Languages & Frameworks',
      ring: 'Trial',
      status: 'Trending',
      tags: ['systems', 'performance', 'safety'],
      costToPrototype: 60,
      moved: 1,
    },
    {
      id: 5,
      name: 'GraphQL',
      description: 'Query language and runtime for APIs, providing flexible and efficient data fetching.',
      quadrant: 'Languages & Frameworks',
      ring: 'Adopt',
      status: 'Stable',
      tags: ['api', 'backend', 'web'],
      costToPrototype: 35,
      moved: 0,
    },
    {
      id: 6,
      name: 'WebAssembly',
      description: 'Binary instruction format for stack-based virtual machines enabling high-performance web apps.',
      quadrant: 'Platforms',
      ring: 'Assess',
      status: 'New',
      tags: ['web', 'performance', 'browser'],
      costToPrototype: 70,
      moved: 0,
    },
  ],
  'nutrition-bu': [
    {
      id: 1,
      name: 'AI Flavor Prediction',
      description: 'Machine learning models for predicting flavor combinations and consumer preferences.',
      quadrant: 'AI & ML',
      ring: 'Trial',
      status: 'Trending',
      tags: ['ai', 'flavor', 'prediction'],
      costToPrototype: 55,
      moved: 1,
    },
    {
      id: 2,
      name: 'Sustainable Packaging',
      description: 'Biodegradable and recyclable packaging materials for food products.',
      quadrant: 'Packaging',
      ring: 'Adopt',
      status: 'Stable',
      tags: ['sustainability', 'packaging', 'eco'],
      costToPrototype: 45,
      moved: 0,
    },
    {
      id: 3,
      name: 'Precision Fermentation',
      description: 'Using microorganisms to produce proteins and other ingredients at scale.',
      quadrant: 'Processing',
      ring: 'Assess',
      status: 'Trending',
      tags: ['fermentation', 'biotech', 'ingredients'],
      costToPrototype: 80,
      moved: 1,
    },
  ],
};

/**
 * Companies - Vendors, partners, and startups
 */
const COMPANIES = [
  {
    id: 'datadog-001',
    name: 'Datadog',
    description: 'Monitoring and analytics platform for cloud-scale applications.',
    website: 'https://www.datadoghq.com',
    logo: '',
    type: ['corporate'], // Updated: Vendor -> corporate
    industry: ['technology'], // Updated: DevOps/Monitoring/Cloud -> technology
    size: 'enterprise', // Updated: Enterprise -> enterprise (lowercase)
    stage: 'public', // Updated: Public -> public (lowercase)
    location: { city: 'New York', country: 'USA' },
    status: 'Partner',
    tags: ['monitoring', 'observability', 'apm'],
    socialLinks: {
      linkedin: 'https://linkedin.com/company/datadog',
      twitter: 'https://twitter.com/datadoghq',
      github: '',
    },
    technologyStack: ['Go', 'Python', 'Kubernetes'],
    documents: [],
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'anthropic-001',
    name: 'Anthropic',
    description: 'AI safety company building reliable, interpretable, and steerable AI systems.',
    website: 'https://www.anthropic.com',
    logo: '',
    type: ['corporate'], // Updated: Partner/Vendor -> corporate
    industry: ['technology'], // Updated: AI/Technology -> technology
    size: 'large', // Updated: Mid-Market -> large
    stage: 'series_c_plus', // Updated: Series C -> series_c_plus
    location: { city: 'San Francisco', country: 'USA' },
    status: 'Partner',
    tags: ['ai', 'llm', 'safety', 'claude'],
    socialLinks: {
      linkedin: 'https://linkedin.com/company/anthropic',
      twitter: 'https://twitter.com/anthropicai',
      github: '',
    },
    technologyStack: ['Python', 'JAX', 'Kubernetes'],
    documents: [],
    createdAt: now - 60 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'flavorwise-001',
    name: 'FlavorWise AI',
    description: 'AI-powered flavor prediction and optimization startup.',
    website: 'https://www.flavorwise.ai',
    logo: '',
    type: ['startup'], // Updated: Startup/Vendor -> startup
    industry: ['technology'], // Updated: FoodTech/AI -> technology
    size: 'small', // Updated: Startup -> small
    stage: 'series_a', // Updated: Series A -> series_a
    location: { city: 'Boston', country: 'USA' },
    status: 'Watching',
    tags: ['ai', 'flavor', 'foodtech', 'startup'],
    socialLinks: { linkedin: '', twitter: '', github: '' },
    technologyStack: ['Python', 'TensorFlow', 'AWS'],
    documents: [],
    createdAt: now - 15 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'greenpak-001',
    name: 'GreenPak Solutions',
    description: 'Sustainable packaging materials and design solutions.',
    website: 'https://www.greenpaksolutions.com',
    logo: '',
    type: ['sme'], // Updated: Vendor -> sme
    industry: ['manufacturing'], // Updated: Packaging/Sustainability -> manufacturing
    size: 'medium', // Updated: SME -> medium
    stage: 'private', // Updated: Established -> private
    location: { city: 'Amsterdam', country: 'Netherlands' },
    status: 'Contacted',
    tags: ['packaging', 'sustainability', 'eco-friendly'],
    socialLinks: { linkedin: '', twitter: '', github: '' },
    technologyStack: [],
    documents: [],
    createdAt: now - 20 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
];

/**
 * Strategies with directives
 */
const STRATEGIES = [
  {
    id: 'ai-transformation-2025',
    name: 'AI Transformation 2025',
    description: 'Drive AI adoption across all business units to increase efficiency and innovation.',
    mainDirectives: [
      {
        id: 'dir-1',
        directive: 'Implement AI-powered automation in 50% of manual processes',
        category: 'Efficiency',
        metrics: { target: '50% automation', timeline: 'by Q4 2025', baseline: 'Current: 15%' },
        priority: 9,
      },
      {
        id: 'dir-2',
        directive: 'Launch 10 AI-powered products across business units',
        category: 'Innovation',
        metrics: { target: '10 products', timeline: 'by 2026', baseline: 'Current: 2' },
        priority: 8,
      },
    ],
    content: '# AI Transformation Strategy\n\nOur goal is to become an AI-first organization...',
    documents: [],
    links: [{ title: 'AI Strategy Deck', url: 'https://example.com/ai-strategy.pdf' }],
    createdAt: now - 90 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'sustainability-2030',
    name: 'Sustainability 2030',
    description: 'Achieve carbon neutrality and sustainable operations by 2030.',
    mainDirectives: [
      {
        id: 'dir-1',
        directive: 'Reduce carbon footprint by 50%',
        category: 'Sustainability',
        metrics: { target: '50% reduction', timeline: 'by 2027', baseline: 'Current: baseline 2023' },
        priority: 10,
      },
      {
        id: 'dir-2',
        directive: '100% recyclable packaging',
        category: 'Sustainability',
        metrics: { target: '100% recyclable', timeline: 'by 2028', baseline: 'Current: 40%' },
        priority: 9,
      },
    ],
    content: '# Sustainability Strategy\n\nCommitment to environmental responsibility...',
    documents: [],
    links: [],
    createdAt: now - 120 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
];

/**
 * Use Cases
 */
const USE_CASES = [
  {
    id: 'uc-flavor-prediction',
    title: 'AI-Powered Flavor Prediction',
    description: 'Use machine learning to predict consumer flavor preferences and optimize recipes.',
    problem: 'Traditional flavor development is time-consuming and relies on expensive consumer testing.',
    solution: 'Deploy AI models trained on historical preference data to predict successful flavor combinations.',
    outcomes: ['Reduce R&D time by 40%', 'Increase hit rate of new products', 'Lower consumer testing costs'],
    status: 'In Progress',
    category: 'AI/ML',
    radarTechnologyIds: ['nutrition-bu:1'],
    companyIds: ['flavorwise-001'],
    tags: ['ai', 'flavor', 'r&d'],
    createdAt: now - 45 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'uc-sustainable-packaging',
    title: 'Zero-Waste Packaging Initiative',
    description: 'Transition all product lines to 100% recyclable or compostable packaging.',
    problem: "Current packaging generates significant waste and doesn't meet sustainability goals.",
    solution: 'Partner with sustainable packaging vendors and redesign packaging across product lines.',
    outcomes: ['100% recyclable packaging', 'Improved brand perception', 'Compliance with regulations'],
    status: 'Proposed',
    category: 'Sustainability',
    radarTechnologyIds: ['nutrition-bu:2'],
    companyIds: ['greenpak-001'],
    tags: ['sustainability', 'packaging', 'esg'],
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'uc-llm-customer-service',
    title: 'LLM-Powered Customer Service',
    description: 'Deploy large language models to automate customer service inquiries.',
    problem: 'High volume of repetitive customer inquiries strains support team.',
    solution: 'Implement Claude or GPT-based chatbot to handle tier-1 support queries.',
    outcomes: ['50% reduction in support tickets', '24/7 availability', 'Improved response time'],
    status: 'Implemented',
    category: 'AI/ML',
    radarTechnologyIds: ['innovation-radar:1'],
    companyIds: ['anthropic-001'],
    tags: ['ai', 'customer-service', 'automation'],
    createdAt: now - 60 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
];

/**
 * Prototypes
 */
const PROTOTYPES = [
  {
    id: 'proto-flavor-ai',
    name: 'FlavorLab AI',
    description: 'AI-powered flavor recommendation engine prototype.',
    status: 'Demo Ready',
    linkedTechnologies: ['nutrition-bu:1'],
    linkedCompanies: ['flavorwise-001'],
    linkedUseCases: ['uc-flavor-prediction'],
    linkedStrategies: ['ai-transformation-2025'],
    targetBusinessUnit: 'Nutrition',
    presentedTo: ['VP of R&D', 'Chief Innovation Officer'],
    presentationDate: now - 7 * 24 * 60 * 60 * 1000,
    artifacts: {
      demoUrl: 'https://demo.flavorlab.internal',
      repoUrl: 'https://github.com/internal/flavorlab-ai',
      presentations: [],
    },
    impact: {
      type: 'Cost Saving',
      estimatedValue: 500000,
      timeToImpact: '6 months',
      confidence: 75,
      notes: 'Based on projected reduction in R&D cycles',
    },
    team: ['Dr. Jane Smith', 'John Doe', 'AI Team'],
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'proto-support-bot',
    name: 'Claude Support Bot',
    description: 'Customer service chatbot powered by Claude for tier-1 support automation.',
    status: 'Delivered',
    linkedTechnologies: ['innovation-radar:1'],
    linkedCompanies: ['anthropic-001'],
    linkedUseCases: ['uc-llm-customer-service'],
    linkedStrategies: ['ai-transformation-2025'],
    targetBusinessUnit: 'Cross-BU',
    presentedTo: ['Chief Digital Officer', 'VP Customer Experience'],
    presentationDate: now - 60 * 24 * 60 * 60 * 1000,
    artifacts: {
      demoUrl: 'https://support.internal/bot',
      presentations: [],
    },
    impact: {
      type: 'Cost Saving',
      estimatedValue: 1200000,
      actualValue: 1100000,
      timeToImpact: '3 months',
      confidence: 90,
      measuredDate: now - 30 * 24 * 60 * 60 * 1000,
      notes: 'Actual savings slightly below estimate due to longer rollout',
    },
    team: ['Digital Team', 'Support Operations'],
    createdAt: now - 90 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'proto-packaging-redesign',
    name: 'EcoPack Pilot',
    description: 'Sustainable packaging redesign pilot for snack product line.',
    status: 'In Development',
    linkedTechnologies: ['nutrition-bu:2'],
    linkedCompanies: ['greenpak-001'],
    linkedUseCases: ['uc-sustainable-packaging'],
    linkedStrategies: ['sustainability-2030'],
    targetBusinessUnit: 'Nutrition',
    presentedTo: [],
    artifacts: {
      presentations: [],
    },
    impact: {
      type: 'Business Transformation',
      estimatedValue: 300000,
      timeToImpact: '12 months',
      confidence: 60,
      notes: 'Value includes brand perception and regulatory compliance',
    },
    team: ['Packaging Team', 'Sustainability Office'],
    createdAt: now - 14 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
];

/**
 * Signals - External discoveries
 */
const SIGNALS = [
  {
    id: 'signal-patent-flavor-ai',
    type: 'patent',
    title: 'Novel AI System for Flavor Combination Prediction',
    description: 'Patent filing for an AI system that predicts optimal flavor combinations using neural networks.',
    source: 'Google Patents',
    url: 'https://patents.google.com/patent/US12345678',
    date: now - 5 * 24 * 60 * 60 * 1000,
    relevanceScore: 92,
    alignmentScore: 88,
    alignedStrategies: ['ai-transformation-2025'],
    linkedEntities: { technologies: ['nutrition-bu:1'], companies: [] },
    status: 'Validated',
    sentiment: 'positive',
    aiSummary:
      'This patent describes a novel approach to flavor prediction using deep learning, potentially disrupting traditional R&D processes.',
    detectedAt: now - 5 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'signal-news-llm-enterprise',
    type: 'news',
    title: 'Enterprise LLM Adoption Doubles in 2024',
    description: 'New report shows enterprise adoption of large language models doubled compared to previous year.',
    source: 'TechCrunch',
    url: 'https://techcrunch.com/article/enterprise-llm-adoption',
    date: now - 3 * 24 * 60 * 60 * 1000,
    relevanceScore: 85,
    alignmentScore: 95,
    alignedStrategies: ['ai-transformation-2025'],
    linkedEntities: { technologies: ['innovation-radar:1'], companies: ['anthropic-001'] },
    status: 'Approved',
    sentiment: 'positive',
    aiSummary: 'Industry report confirms strong momentum in LLM adoption, validating our AI transformation strategy.',
    detectedAt: now - 3 * 24 * 60 * 60 * 1000,
    reviewedAt: now - 2 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'signal-funding-packaging',
    type: 'funding',
    title: 'Sustainable Packaging Startup Raises $50M Series B',
    description: 'EcoWrap Technologies secures major funding round for biodegradable packaging innovation.',
    source: 'Crunchbase',
    url: 'https://crunchbase.com/funding/ecowrap-series-b',
    date: now - 7 * 24 * 60 * 60 * 1000,
    relevanceScore: 78,
    alignmentScore: 82,
    alignedStrategies: ['sustainability-2030'],
    linkedEntities: { technologies: ['nutrition-bu:2'], companies: [] },
    status: 'Detected',
    sentiment: 'positive',
    aiSummary:
      'New player in sustainable packaging space with significant funding could be potential partner or competitor.',
    detectedAt: now - 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'signal-paper-fermentation',
    type: 'paper',
    title: 'Advances in Precision Fermentation for Protein Production',
    description: 'Academic paper presenting breakthrough in precision fermentation yields.',
    source: 'Nature Biotechnology',
    url: 'https://nature.com/articles/precision-fermentation-2025',
    date: now - 10 * 24 * 60 * 60 * 1000,
    relevanceScore: 88,
    alignmentScore: 75,
    alignedStrategies: [],
    linkedEntities: { technologies: ['nutrition-bu:3'], companies: [] },
    status: 'Validated',
    sentiment: 'positive',
    aiSummary: 'Research breakthrough could accelerate precision fermentation adoption for ingredient production.',
    detectedAt: now - 10 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'signal-github-vector-db',
    type: 'github',
    title: 'Vector Database Library Gains 10K Stars',
    description: 'Open source vector database library sees explosive growth in developer adoption.',
    source: 'GitHub Trending',
    url: 'https://github.com/vectordb/vectordb',
    date: now - 2 * 24 * 60 * 60 * 1000,
    metadata: { stars: 15000, forks: 1200, language: 'Rust' },
    relevanceScore: 82,
    alignmentScore: 70,
    alignedStrategies: ['ai-transformation-2025'],
    linkedEntities: { technologies: ['innovation-radar:2'], companies: [] },
    status: 'Detected',
    sentiment: 'positive',
    aiSummary: 'Growing adoption of this vector database could inform our AI infrastructure decisions.',
    detectedAt: now - 2 * 24 * 60 * 60 * 1000,
  },
];

/**
 * Relations between entities
 */
const RELATIONS = [
  {
    id: 'rel-001',
    relationType: 'vendor',
    sourceSnapshot: {
      type: 'company',
      id: 'anthropic-001',
      name: 'Anthropic',
      status: 'Partner',
      snapshotAt: now,
    },
    targetSnapshot: {
      type: 'technology',
      id: 'innovation-radar:1',
      name: 'Large Language Models',
      status: 'Trending',
      snapshotAt: now,
    },
    notes: 'Anthropic provides Claude models for our LLM initiatives',
    confidence: 95,
    aiSuggested: false,
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'rel-002',
    relationType: 'addresses',
    sourceSnapshot: {
      type: 'technology',
      id: 'nutrition-bu:1',
      name: 'AI Flavor Prediction',
      status: 'Trending',
      snapshotAt: now,
    },
    targetSnapshot: {
      type: 'useCase',
      id: 'uc-flavor-prediction',
      name: 'AI-Powered Flavor Prediction',
      status: 'In Progress',
      snapshotAt: now,
    },
    confidence: 90,
    aiSuggested: true,
    createdAt: now - 20 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'rel-003',
    relationType: 'aligns_with',
    sourceSnapshot: {
      type: 'technology',
      id: 'innovation-radar:1',
      name: 'Large Language Models',
      status: 'Trending',
      snapshotAt: now,
    },
    targetSnapshot: {
      type: 'strategy',
      id: 'ai-transformation-2025',
      name: 'AI Transformation 2025',
      snapshotAt: now,
    },
    notes: 'LLMs are core to our AI transformation strategy',
    confidence: 100,
    aiSuggested: false,
    createdAt: now - 60 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
  {
    id: 'rel-004',
    relationType: 'supports',
    sourceSnapshot: {
      type: 'prototype',
      id: 'proto-flavor-ai',
      name: 'FlavorLab AI',
      status: 'Demo Ready',
      snapshotAt: now,
    },
    targetSnapshot: {
      type: 'technology',
      id: 'nutrition-bu:1',
      name: 'AI Flavor Prediction',
      status: 'Trending',
      snapshotAt: now,
    },
    confidence: 95,
    aiSuggested: false,
    createdAt: now - 15 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  },
];

/** Deterministic uniqueness locks paired one-to-one with seeded relations. */
export const EMULATOR_RELATION_TRIPLE_LOCKS = RELATIONS.map((relation) =>
  buildRelationTripleLockEntry(
    relation.id,
    relation.sourceSnapshot.id,
    relation.targetSnapshot.id,
    relation.relationType,
    relation.createdAt
  )
);

/**
 * Proposed Relations - AI-suggested relations for Linker Triage testing
 */
const PROPOSED_RELATIONS = [
  {
    id: 'prop-001',
    sourceType: 'company',
    sourceId: 'anthropic-001',
    sourceSnapshot: {
      type: 'company',
      name: 'Anthropic',
      description: 'AI safety company building reliable, interpretable AI systems.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'innovation-radar:1',
    targetSnapshot: {
      type: 'technology',
      name: 'Large Language Models',
      description: 'Foundation models for text generation and reasoning tasks.',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 92,
    reasoning: 'Anthropic develops Claude, a leading large language model, making them a key vendor in the LLM space.',
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-20260120-001',
    createdAt: now - 2 * 24 * 60 * 60 * 1000,
    updatedAt: now - 2 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-002',
    sourceType: 'company',
    sourceId: 'flavorwise-001',
    sourceSnapshot: {
      type: 'company',
      name: 'FlavorWise AI',
      description: 'AI-powered flavor prediction and optimization startup.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'nutrition-bu:1',
    targetSnapshot: {
      type: 'technology',
      name: 'AI Flavor Prediction',
      description: 'Machine learning models for predicting flavor combinations.',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 88,
    reasoning:
      'FlavorWise AI specializes in flavor prediction technology, directly aligning with our AI Flavor Prediction radar entry.',
    status: 'pending',
    discoveredBy: 'auto-linker',
    createdAt: now - 3 * 24 * 60 * 60 * 1000,
    updatedAt: now - 3 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-003',
    sourceType: 'technology',
    sourceId: 'innovation-radar:2',
    sourceSnapshot: {
      type: 'technology',
      name: 'Vector Databases',
      description: 'Specialized databases for storing high-dimensional vectors for AI.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'innovation-radar:1',
    targetSnapshot: {
      type: 'technology',
      name: 'Large Language Models',
      description: 'Foundation models for text generation and reasoning.',
      snapshotAt: now,
    },
    relationType: 'enables',
    confidence: 95,
    reasoning:
      'Vector databases are essential infrastructure for RAG (Retrieval Augmented Generation) systems that enhance LLM capabilities.',
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-20260120-001',
    createdAt: now - 1 * 24 * 60 * 60 * 1000,
    updatedAt: now - 1 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-004',
    sourceType: 'company',
    sourceId: 'greenpak-001',
    sourceSnapshot: {
      type: 'company',
      name: 'GreenPak Solutions',
      description: 'Sustainable packaging materials and design solutions.',
      snapshotAt: now,
    },
    targetType: 'useCase',
    targetId: 'uc-sustainable-packaging',
    targetSnapshot: {
      type: 'useCase',
      name: 'Zero-Waste Packaging Initiative',
      description: 'Transition to 100% recyclable or compostable packaging.',
      snapshotAt: now,
    },
    relationType: 'addresses',
    confidence: 82,
    reasoning:
      'GreenPak Solutions offers sustainable packaging expertise that directly addresses our Zero-Waste Packaging Initiative.',
    status: 'pending',
    discoveredBy: 'ai-assistant',
    createdAt: now - 4 * 24 * 60 * 60 * 1000,
    updatedAt: now - 4 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-005',
    sourceType: 'strategy',
    sourceId: 'ai-transformation-2025',
    sourceSnapshot: {
      type: 'strategy',
      name: 'AI Transformation 2025',
      description: 'Drive AI adoption across all business units.',
      snapshotAt: now,
    },
    targetType: 'prototype',
    targetId: 'proto-support-bot',
    targetSnapshot: {
      type: 'prototype',
      name: 'Claude Support Bot',
      description: 'Customer service chatbot powered by Claude.',
      snapshotAt: now,
    },
    relationType: 'drives',
    confidence: 90,
    reasoning:
      'The AI Transformation 2025 strategy directly drives the development of AI-powered prototypes like the Claude Support Bot.',
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-20260119-001',
    createdAt: now - 5 * 24 * 60 * 60 * 1000,
    updatedAt: now - 5 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-006',
    sourceType: 'company',
    sourceId: 'datadog-001',
    sourceSnapshot: {
      type: 'company',
      name: 'Datadog',
      description: 'Monitoring and analytics platform for cloud-scale applications.',
      snapshotAt: now,
    },
    targetType: 'technology',
    targetId: 'innovation-radar:3',
    targetSnapshot: {
      type: 'technology',
      name: 'Kubernetes',
      description: 'Container orchestration platform.',
      snapshotAt: now,
    },
    relationType: 'supports',
    confidence: 78,
    reasoning:
      'Datadog provides comprehensive Kubernetes monitoring capabilities, supporting organizations using container orchestration.',
    status: 'pending',
    discoveredBy: 'auto-linker',
    createdAt: now - 6 * 24 * 60 * 60 * 1000,
    updatedAt: now - 6 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-007',
    sourceType: 'technology',
    sourceId: 'nutrition-bu:3',
    sourceSnapshot: {
      type: 'technology',
      name: 'Precision Fermentation',
      description: 'Using microorganisms to produce proteins and ingredients at scale.',
      snapshotAt: now,
    },
    targetType: 'strategy',
    targetId: 'sustainability-2030',
    targetSnapshot: {
      type: 'strategy',
      name: 'Sustainability 2030',
      description: 'Achieve carbon neutrality and sustainable operations by 2030.',
      snapshotAt: now,
    },
    relationType: 'aligns_with',
    confidence: 85,
    reasoning:
      'Precision fermentation technology aligns with sustainability goals by offering lower environmental impact protein production.',
    status: 'pending',
    discoveredBy: 'linker-agent',
    runId: 'run-20260118-001',
    createdAt: now - 7 * 24 * 60 * 60 * 1000,
    updatedAt: now - 7 * 24 * 60 * 60 * 1000,
  },
  // Previously processed proposals for testing list view filters
  {
    id: 'prop-008',
    sourceType: 'company',
    sourceId: 'anthropic-001',
    sourceSnapshot: {
      type: 'company',
      name: 'Anthropic',
      description: 'AI safety company.',
      snapshotAt: now - 30 * 24 * 60 * 60 * 1000,
    },
    targetType: 'useCase',
    targetId: 'uc-llm-customer-service',
    targetSnapshot: {
      type: 'useCase',
      name: 'LLM-Powered Customer Service',
      description: 'Deploy LLMs to automate customer service.',
      snapshotAt: now - 30 * 24 * 60 * 60 * 1000,
    },
    relationType: 'enables',
    confidence: 94,
    reasoning: "Anthropic's Claude is used in our LLM-powered customer service implementation.",
    status: 'approved',
    discoveredBy: 'linker-agent',
    runId: 'run-20251220-001',
    reviewedAt: now - 25 * 24 * 60 * 60 * 1000,
    reviewedBy: 'user@example.com',
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now - 25 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prop-009',
    sourceType: 'technology',
    sourceId: 'innovation-radar:6',
    sourceSnapshot: {
      type: 'technology',
      name: 'WebAssembly',
      description: 'Binary instruction format for web apps.',
      snapshotAt: now - 20 * 24 * 60 * 60 * 1000,
    },
    targetType: 'company',
    targetId: 'flavorwise-001',
    targetSnapshot: {
      type: 'company',
      name: 'FlavorWise AI',
      description: 'AI-powered flavor prediction.',
      snapshotAt: now - 20 * 24 * 60 * 60 * 1000,
    },
    relationType: 'uses',
    confidence: 45,
    reasoning: "Potential use of WebAssembly for performance in FlavorWise's web application.",
    status: 'rejected',
    discoveredBy: 'auto-linker',
    feedbackReason: 'Low confidence and speculative. No evidence of WebAssembly usage.',
    reviewedAt: now - 18 * 24 * 60 * 60 * 1000,
    reviewedBy: 'reviewer@example.com',
    createdAt: now - 20 * 24 * 60 * 60 * 1000,
    updatedAt: now - 18 * 24 * 60 * 60 * 1000,
  },
];

// ============================================================================
// SEEDING FUNCTIONS
// ============================================================================

export const EMULATOR_COLLECTIONS_TO_CLEAR = [
  'radars',
  'companies',
  'strategies',
  ENTITY_COLLECTIONS.useCase,
  'prototypes',
  'signals',
  'relations',
  RELATION_TRIPLE_LOCK_COLLECTION,
  RELATION_SYNC_OUTBOX_COLLECTION,
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  'graphReconciliationCursors',
  'proposedRelations',
  'system-config',
];

/**
 * Clears all documents from a collection
 */
async function clearCollection(collectionName: string): Promise<number> {
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
 * Seeds radars and their entries
 */
async function seedRadars(): Promise<void> {
  console.log('[Seed] Seeding radars...');

  for (const radar of RADARS) {
    // Create radar document
    await setDoc(doc(db, 'radars', radar.id), radar);
    console.log(`  Created radar: ${radar.name}`);

    // Create entries subcollection
    const entries = TECHNOLOGIES[radar.id] || [];
    for (const entry of entries) {
      await setDoc(doc(db, `radars/${radar.id}/entries`, String(entry.id)), {
        ...entry,
        linkedCompanies: [],
        linkedUseCases: [],
        history: [
          {
            date: new Date().toISOString().split('T')[0],
            ring: entry.ring,
            status: entry.status,
          },
        ],
      });
    }
    console.log(`    Added ${entries.length} technologies to ${radar.name}`);
  }
}

/**
 * Seeds companies
 */
async function seedCompanies(): Promise<void> {
  console.log('[Seed] Seeding companies...');

  for (const company of COMPANIES) {
    await setDoc(doc(db, 'companies', company.id), company);
  }

  console.log(`  Created ${COMPANIES.length} companies`);
}

/**
 * Seeds strategies
 */
async function seedStrategies(): Promise<void> {
  console.log('[Seed] Seeding strategies...');

  for (const strategy of STRATEGIES) {
    await setDoc(doc(db, 'strategies', strategy.id), strategy);
  }

  console.log(`  Created ${STRATEGIES.length} strategies`);
}

/**
 * Seeds use cases
 */
async function seedUseCases(): Promise<void> {
  console.log('[Seed] Seeding use cases...');

  for (const useCase of USE_CASES) {
    await setDoc(doc(db, ENTITY_COLLECTIONS.useCase, useCase.id), useCase);
  }

  console.log(`  Created ${USE_CASES.length} use cases`);
}

/**
 * Seeds prototypes
 */
async function seedPrototypes(): Promise<void> {
  console.log('[Seed] Seeding prototypes...');

  for (const prototype of PROTOTYPES) {
    await setDoc(doc(db, 'prototypes', prototype.id), prototype);
  }

  console.log(`  Created ${PROTOTYPES.length} prototypes`);
}

/**
 * Seeds signals
 */
async function seedSignals(): Promise<void> {
  console.log('[Seed] Seeding signals...');

  for (const signal of SIGNALS) {
    await setDoc(doc(db, 'signals', signal.id), signal);
  }

  console.log(`  Created ${SIGNALS.length} signals`);
}

/**
 * Seeds relations
 */
async function seedRelations(): Promise<void> {
  console.log('[Seed] Seeding relations...');

  const batch = writeBatch(db);
  for (const relation of RELATIONS) {
    batch.set(doc(db, 'relations', relation.id), relation);
  }
  for (const lock of EMULATOR_RELATION_TRIPLE_LOCKS) {
    batch.set(doc(db, RELATION_TRIPLE_LOCK_COLLECTION, lock.id), lock.data);
  }
  await batch.commit();

  console.log(`  Created ${RELATIONS.length} relations + deterministic triple locks`);
}

/**
 * Seeds proposed relations for Linker Triage testing
 */
async function seedProposedRelations(): Promise<void> {
  console.log('[Seed] Seeding proposed relations...');

  for (const proposal of PROPOSED_RELATIONS) {
    await setDoc(doc(db, 'proposedRelations', proposal.id), proposal);
  }

  console.log(`  Created ${PROPOSED_RELATIONS.length} proposed relations`);
}

/**
 * System configuration seed document. Exported so the colocated test can
 * assert it tracks the canonical shared defaults.
 */
export const SYSTEM_CONFIG_SEED = {
  id: 'global',
  agentMode: {
    mode: 'copilot',
    autoActionThreshold: 90,
    autoAddTechnologies: false,
    autoUpdateMaturity: false,
    autoLinkRelationships: false,
    autoImportSignals: false,
  },
  signalDetection: {
    enabled: true,
    minRelevanceScore: 50,
    // Canonical defaults from src/lib/signal-source-defaults.ts and
    // DEFAULT_CONFIG in src/lib/system-config.ts (minRelevanceScore 50 in both;
    // patents off: retired endpoint; funding off: paid API; Trends off: no
    // registered fetcher; SEC opt-in. See docs/LIMITATIONS.md.
    sources: { ...DEFAULT_SIGNAL_SOURCES },
  },
  linkerAgent: {
    enabled: false,
  },
  sweep: {
    enabled: false,
    maxActionsPerSweep: 10,
  },
  notifications: {
    email: false,
    dashboard: true,
  },
  updatedAt: now,
};

/**
 * Seeds system configuration
 */
async function seedSystemConfig(): Promise<void> {
  console.log('[Seed] Seeding system configuration...');

  // Collection name MUST match the reader: getSystemConfig() reads
  // 'system-config' (CONFIG_COLLECTION in src/lib/system-config.ts), and the
  // Inngest pipelines read adminDb.collection('system-config'). Writing
  // 'systemConfig' (camelCase) here previously left the seeded config dead.
  await setDoc(doc(db, 'system-config', 'global'), SYSTEM_CONFIG_SEED);
  console.log('  Created system configuration');
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

/**
 * Mirrors the seeded Firestore content into Neo4j so the graph-backed UI
 * (radar relationships, super-graph, GraphRAG tools) has data on a fresh
 * clone. Without this, `firebase:seed` writes only to Firestore and Neo4j
 * stays empty — the showcase value of the prototype depends on the graph
 * being populated.
 *
 * Best-effort: if NEO4J_URI isn't set or the driver can't connect, we log
 * a warning and continue. The Firestore seed remains the source of truth.
 */
async function syncSeededDataToNeo4j(): Promise<void> {
  console.log('[Seed] Syncing seeded data to Neo4j...');

  if (!process.env.NEO4J_URI) {
    console.warn('  [warn]NEO4J_URI not set — skipping graph sync. Graph-backed UI will be empty.');
    return;
  }

  // Build entity list: technologies use the composite `${radarId}:${entryId}`
  // id because the seeded relations reference that same shape (see RELATIONS
  // snapshots above — `id: 'innovation-radar:1'`).
  const entities: SeedEntity[] = [
    ...Object.entries(TECHNOLOGIES).flatMap(([radarId, entries]) =>
      entries.map((e) => ({
        id: `${radarId}:${e.id}`,
        type: 'technology' as const,
        name: e.name,
        properties: {
          description: e.description,
          quadrant: e.quadrant,
          ring: e.ring,
          status: e.status,
          tags: e.tags,
          radarId,
        },
      }))
    ),
    ...COMPANIES.map((c) => ({
      id: c.id,
      type: 'company' as const,
      name: c.name,
      properties: { description: c.description, status: c.status, tags: c.tags },
    })),
    ...STRATEGIES.map((s) => ({
      id: s.id,
      type: 'strategy' as const,
      name: s.name,
      properties: { description: s.description },
    })),
    ...USE_CASES.map((u) => ({
      id: u.id,
      type: 'useCase' as const,
      name: u.title,
      properties: { description: u.description, status: u.status },
    })),
    ...PROTOTYPES.map((p) => ({
      id: p.id,
      type: 'prototype' as const,
      name: p.name,
      properties: { description: p.description, status: p.status },
    })),
    ...SIGNALS.map((s) => ({
      id: s.id,
      type: 'signal' as const,
      name: s.title,
      properties: { description: s.description ?? '', status: s.status, signalType: s.type },
    })),
  ];

  const relations: SeedRelation[] = RELATIONS.map((r) => ({
    id: r.id,
    relationType: r.relationType,
    sourceSnapshot: {
      id: r.sourceSnapshot.id,
      type: r.sourceSnapshot.type,
      name: r.sourceSnapshot.name,
    },
    targetSnapshot: {
      id: r.targetSnapshot.id,
      type: r.targetSnapshot.type,
      name: r.targetSnapshot.name,
    },
    confidence: r.confidence,
    aiSuggested: r.aiSuggested,
    notes: 'notes' in r ? (r as { notes?: string }).notes : undefined,
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
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Radarist Firestore Emulator Seed Script');
  console.log('='.repeat(60));
  console.log('');

  try {
    // Fail closed before any delete: this seed batch-clears whole collections
    // (relations, relation-triple locks, and the durable relationSyncOutbox)
    // with no per-relation outbox marker or lock-ownership check, which is only
    // ever safe against a disposable local emulator (GRAPH-038). Rejects a real
    // project id or an explicit non-loopback emulator host.
    assertDisposableFirestoreResetTarget(firebaseConfig.projectId);

    // Clear existing data
    console.log('[Seed] Clearing existing data...');
    for (const collectionName of EMULATOR_COLLECTIONS_TO_CLEAR) {
      const count = await clearCollection(collectionName);
      if (count > 0) {
        console.log(`  Cleared ${count} documents from ${collectionName}`);
      }
    }

    // Clear radar entries subcollections
    for (const radar of RADARS) {
      const entriesCount = await clearCollection(`radars/${radar.id}/entries`);
      if (entriesCount > 0) {
        console.log(`  Cleared ${entriesCount} entries from ${radar.id}`);
      }
    }

    console.log('');

    // Seed all collections
    await seedRadars();
    await seedCompanies();
    await seedStrategies();
    await seedUseCases();
    await seedPrototypes();
    await seedSignals();
    await seedRelations();
    await seedProposedRelations();
    await seedSystemConfig();

    // Bootstrap Neo4j from the seeded Firestore content. Without this step
    // the graph-backed UI (radar relationships, super-graph, GraphRAG) is
    // empty on a fresh OSS clone — the documented `firebase:seed` flow
    // wrote only to Firestore via raw setDoc (bypassing the entity-factory
    // → Inngest sync chain).
    console.log('');
    await syncSeededDataToNeo4j();

    console.log('');
    console.log('='.repeat(60));
    console.log('Seed completed successfully!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Summary:');
    console.log(`  - ${RADARS.length} radars with ${Object.values(TECHNOLOGIES).flat().length} technologies`);
    console.log(`  - ${COMPANIES.length} companies`);
    console.log(`  - ${STRATEGIES.length} strategies`);
    console.log(`  - ${USE_CASES.length} use cases`);
    console.log(`  - ${PROTOTYPES.length} prototypes`);
    console.log(`  - ${SIGNALS.length} signals`);
    console.log(`  - ${RELATIONS.length} relations`);
    console.log(`  - ${PROPOSED_RELATIONS.length} proposed relations (for Linker Triage)`);
    console.log('');
    console.log('You can now browse the data at http://127.0.0.1:4000/firestore');
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('Seed failed!');
    console.error('='.repeat(60));
    console.error(error);
    process.exit(1);
  }
}

// Only run when executed directly (same guard as seed-demo.ts) — lets the
// colocated test import the exported seed constants without side effects.
if (require.main === module) {
  main().catch(console.error);
}
