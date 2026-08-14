/**
 * @file lib/schemas/company.ts
 * @description Zod validation schemas for Company entities
 *
 * Provides runtime validation for company data with the updated
 * enum values from Phase 4 of the Knowledge Tab Sprint.
 *
 * @phase Knowledge Tab Sprint - Phase 4
 * @author Radarist Team
 * @created 2026-01-14
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';

const log = createLogger('schemas/company');

// ============================================================================
// ENUM SCHEMAS
// ============================================================================

/**
 * Company type classifications.
 * Represents the company's lifecycle stage and organizational type.
 */
export const companyTypeSchema = z.enum([
  'startup', // Early-stage, pre-product-market fit
  'scaleup', // Growth stage, scaling operations
  'sme', // Small/medium enterprise, stable
  'corporate', // Large established company
  'spinoff', // Corporate spin-off
  'joint_venture', // Joint venture between companies
  'research', // Research institution / university
  'accelerator', // Accelerator or incubator
  'venture_studio', // Venture studio / company builder
  'consultancy', // Consulting / service provider
  'government', // Government agency or body
  'ngo', // Non-governmental organization
  'consortium', // Industry consortium
  'academic', // Academic institution (distinct from research)
]);

export type CompanyTypeValue = z.infer<typeof companyTypeSchema>;

/**
 * Company size categories based on employee count.
 */
export const companySizeSchema = z.enum([
  'micro', // 1-9 employees
  'small', // 10-49 employees
  'medium', // 50-249 employees
  'large', // 250-999 employees
  'enterprise', // 1000+ employees
]);

export type CompanySizeValue = z.infer<typeof companySizeSchema>;

/**
 * Funding/business stage for companies.
 */
export const companyStageSchema = z.enum([
  'pre_seed', // Pre-seed funding
  'seed', // Seed round
  'series_a', // Series A
  'series_b', // Series B
  'series_c_plus', // Series C+
  'bootstrapped', // Self-funded
  'private', // Private, late stage
  'public', // Publicly traded
  'ipo', // Recently IPO'd
  'nonprofit', // Non-profit organization
]);

export type CompanyStageValue = z.infer<typeof companyStageSchema>;

// ============================================================================
// NORMALIZATION MAPS (Legacy -> New)
// ============================================================================

/**
 * Maps legacy and variant company type values to canonical values.
 * Used by z.preprocess for automatic normalization at write boundaries.
 */
const COMPANY_TYPE_NORMALIZE: Record<string, CompanyTypeValue> = {
  // Legacy values -> New values
  Vendor: 'corporate',
  Partner: 'corporate',
  Competitor: 'corporate',
  Startup: 'startup',
  'Research Institution': 'research',
  'Consulting Firm': 'consultancy',
  // Passthrough (already correct)
  startup: 'startup',
  scaleup: 'scaleup',
  sme: 'sme',
  corporate: 'corporate',
  spinoff: 'spinoff',
  joint_venture: 'joint_venture',
  research: 'research',
  accelerator: 'accelerator',
  venture_studio: 'venture_studio',
  consultancy: 'consultancy',
  government: 'government',
  ngo: 'ngo',
  consortium: 'consortium',
  academic: 'academic',
};

/**
 * Maps legacy and variant company size values to canonical values.
 */
const COMPANY_SIZE_NORMALIZE: Record<string, CompanySizeValue> = {
  // Legacy values -> New values
  Startup: 'small',
  SME: 'small',
  'Mid-Market': 'medium',
  Enterprise: 'enterprise',
  // Passthrough (already correct)
  micro: 'micro',
  small: 'small',
  medium: 'medium',
  large: 'large',
  enterprise: 'enterprise',
};

/**
 * Maps legacy and variant company stage values to canonical values.
 */
const COMPANY_STAGE_NORMALIZE: Record<string, CompanyStageValue> = {
  // Legacy values -> New values
  'Pre-seed': 'pre_seed',
  Seed: 'seed',
  'Series A': 'series_a',
  'Series B': 'series_b',
  'Series C': 'series_c_plus',
  'Series D+': 'series_c_plus',
  Public: 'public',
  Established: 'private',
  Bootstrapped: 'bootstrapped',
  Acquired: 'private',
  Unknown: 'seed',
  // Passthrough (already correct)
  pre_seed: 'pre_seed',
  seed: 'seed',
  series_a: 'series_a',
  series_b: 'series_b',
  series_c_plus: 'series_c_plus',
  bootstrapped: 'bootstrapped',
  private: 'private',
  public: 'public',
  ipo: 'ipo',
  nonprofit: 'nonprofit',
};

/**
 * Maps legacy and custom industry values to canonical values.
 */
const COMPANY_INDUSTRY_NORMALIZE: Record<string, CompanyIndustryValue> = {
  // Common legacy/custom industries -> closest match
  DevOps: 'technology',
  AI: 'technology',
  FoodTech: 'food_agriculture',
  Monitoring: 'technology',
  Cloud: 'technology',
  Packaging: 'manufacturing',
  Sustainability: 'energy',
  Software: 'technology',
  SaaS: 'technology',
  Fintech: 'financial',
  Biotech: 'healthcare',
  CleanTech: 'energy',
  EdTech: 'education',
  AgTech: 'food_agriculture',
  Retail: 'consumer',
  retail: 'consumer',
  Healthcare: 'healthcare',
  Technology: 'technology',
  Manufacturing: 'manufacturing',
  Finance: 'financial',
  Defense: 'defense',
  Aerospace: 'defense',
  Education: 'education',
  PropTech: 'real_estate',
  RealEstate: 'real_estate',
  Telecom: 'telecommunications',
  Automotive: 'automotive',
  Mobility: 'automotive',
  Chemicals: 'chemicals',
  Materials: 'chemicals',
  // Passthrough (already correct)
  healthcare: 'healthcare',
  food_agriculture: 'food_agriculture',
  technology: 'technology',
  manufacturing: 'manufacturing',
  energy: 'energy',
  consumer: 'consumer',
  financial: 'financial',
  logistics: 'logistics',
  media: 'media',
  professional: 'professional',
  defense: 'defense',
  education: 'education',
  real_estate: 'real_estate',
  telecommunications: 'telecommunications',
  automotive: 'automotive',
  chemicals: 'chemicals',
  other: 'other',
};

// ============================================================================
// NORMALIZER FUNCTIONS
// ============================================================================

/**
 * Normalizes a company type value, logging warnings for unknown values.
 */
function normalizeCompanyType(val: unknown): CompanyTypeValue | undefined {
  if (typeof val !== 'string') return undefined;
  const normalized = COMPANY_TYPE_NORMALIZE[val];
  if (!normalized && val) {
    log.warn('Unknown company type, defaulting to sme', { value: val });
    return 'sme';
  }
  return normalized;
}

/**
 * Normalizes a company size value, logging warnings for unknown values.
 */
function normalizeCompanySize(val: unknown): CompanySizeValue {
  if (typeof val !== 'string') return 'small';
  const normalized = COMPANY_SIZE_NORMALIZE[val];
  if (!normalized) {
    log.warn('Unknown company size, defaulting to small', { value: val });
    return 'small';
  }
  return normalized;
}

/**
 * Normalizes a company stage value, logging warnings for unknown values.
 */
function normalizeCompanyStage(val: unknown): CompanyStageValue {
  if (typeof val !== 'string') return 'seed';
  const normalized = COMPANY_STAGE_NORMALIZE[val];
  if (!normalized) {
    log.warn('Unknown company stage, defaulting to seed', { value: val });
    return 'seed';
  }
  return normalized;
}

/**
 * Normalizes an industry value, logging warnings for unknown values.
 */
function normalizeCompanyIndustry(val: unknown): CompanyIndustryValue | undefined {
  if (typeof val !== 'string') return undefined;
  const normalized = COMPANY_INDUSTRY_NORMALIZE[val];
  if (!normalized && val) {
    log.warn('Unknown industry, mapping to other', { value: val });
    return 'other';
  }
  return normalized;
}

/**
 * Industry classification for companies.
 */
export const companyIndustrySchema = z.enum([
  'healthcare', // Healthcare & Life Sciences
  'food_agriculture', // Food & Agriculture
  'technology', // Technology & Software
  'manufacturing', // Manufacturing & Industrial
  'energy', // Energy & Environment
  'consumer', // Consumer & Retail
  'financial', // Financial Services
  'logistics', // Logistics & Infrastructure
  'media', // Media & Entertainment
  'professional', // Professional Services
  'defense', // Defense & Aerospace
  'education', // Education & EdTech
  'real_estate', // Real Estate & PropTech
  'telecommunications', // Telecommunications
  'automotive', // Automotive & Mobility
  'chemicals', // Chemicals & Materials
  'other', // Other (requires industryCustom)
]);

export type CompanyIndustryValue = z.infer<typeof companyIndustrySchema>;

/**
 * Company relationship status.
 */
export const companyStatusSchema = z.enum([
  'Watching', // On radar but no contact
  'Contacted', // Initial contact made
  'Partner', // Active partnership
  'Rejected', // Evaluated but not pursuing
]);

export type CompanyStatusValue = z.infer<typeof companyStatusSchema>;

// ============================================================================
// NESTED SCHEMAS
// ============================================================================

/**
 * Company location schema.
 */
export const companyLocationSchema = z.object({
  city: z.string(),
  country: z.string(),
});

/**
 * Company social links schema.
 */
export const companySocialLinksSchema = z
  .object({
    linkedin: z.string().url().optional().or(z.literal('')),
    twitter: z.string().url().optional().or(z.literal('')),
    github: z.string().url().optional().or(z.literal('')),
  })
  .passthrough(); // Allow additional social links

/**
 * Company funding info schema.
 */
export const companyFundingSchema = z.object({
  totalRaised: z.string().optional(),
  lastRound: z.string().optional(),
  investors: z.array(z.string()).default([]),
});

/**
 * Company document schema (embedded documents, not EntityDocumentLink).
 */
export const companyDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['upload', 'link']),
  url: z.string(),
  uploadedAt: z.number(),
});

/**
 * Comprehensive company research schema.
 * Stores structured results of AI-powered company analysis.
 */
export const companyResearchSchema = z.object({
  /** When research was last performed (milliseconds since epoch) */
  lastResearched: z.number(),

  /** Research version for cache invalidation */
  version: z.number(),

  /** Executive Summary */
  executiveSummary: z
    .object({
      overview: z.string(),
      keyHighlights: z.array(z.string()),
      recommendation: z.string().optional(),
    })
    .optional(),

  /** Products & Solutions */
  productsAndSolutions: z
    .object({
      productPortfolio: z.array(z.string()).optional(),
      coreProducts: z
        .array(
          z.object({
            name: z.string(),
            description: z.string(),
            category: z.string().optional(),
          })
        )
        .optional(),
      deploymentModel: z.enum(['cloud', 'on-premise', 'hybrid', 'saas']).optional(),
      integrationCapabilities: z.array(z.string()).optional(),
      productMaturity: z.enum(['emerging', 'growing', 'mature', 'declining']).optional(),
    })
    .optional(),

  /** Financials & Traction */
  financialsAndTraction: z
    .object({
      fundingHistory: z
        .array(
          z.object({
            round: z.string(),
            amount: z.string().optional(),
            date: z.string().optional(),
            investors: z.array(z.string()).optional(),
          })
        )
        .optional(),
      totalRaised: z.string().optional(),
      keyInvestors: z.array(z.string()).optional(),
      revenueRange: z.string().optional(),
      revenueModel: z.enum(['subscription', 'transactional', 'licensing', 'freemium', 'hybrid']).optional(),
      customerCount: z.string().optional(),
      lastYearEarnings: z.string().optional(),
      /** SWOT Analysis (moved from separate tab) */
      swot: z
        .object({
          strengths: z.array(z.string()),
          weaknesses: z.array(z.string()),
          opportunities: z.array(z.string()),
          threats: z.array(z.string()),
        })
        .optional(),
    })
    .optional(),

  /** Team & Leadership */
  teamAndLeadership: z
    .object({
      founders: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            background: z.string().optional(),
            linkedIn: z.string().optional(),
          })
        )
        .optional(),
      keyExecutives: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            background: z.string().optional(),
          })
        )
        .optional(),
      teamSize: z.string().optional(),
      engineeringRatio: z.string().optional(),
      notableHires: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            previousCompany: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),

  /** Innovation Indicators */
  innovationIndicators: z
    .object({
      patentCount: z.number().optional(),
      productVelocity: z.enum(['low', 'medium', 'high']).optional(),
      openSourceActivity: z
        .object({
          repos: z.number().optional(),
          stars: z.number().optional(),
          contributors: z.number().optional(),
        })
        .optional(),
      technicalPublications: z.array(z.string()).optional(),
    })
    .optional(),

  /** Partnerships & Ecosystem */
  partnershipsAndEcosystem: z
    .object({
      strategicPartners: z.array(z.string()).optional(),
      technologyPartners: z.array(z.string()).optional(),
      channelPartners: z.array(z.string()).optional(),
      ecosystemPosition: z.enum(['leader', 'challenger', 'follower', 'niche']).optional(),
    })
    .optional(),

  /** Risk Assessment */
  riskAssessment: z
    .object({
      vendorRiskScore: z.number().min(0).max(100).optional(),
      regulatoryExposure: z.enum(['low', 'medium', 'high']).optional(),
      dependencyRisks: z.array(z.string()).optional(),
      financialHealth: z.enum(['strong', 'stable', 'concerning', 'critical']).optional(),
    })
    .optional(),

  /** Research sources and confidence */
  metadata: z
    .object({
      sources: z.array(z.string()),
      confidenceScore: z.number().min(0).max(100),
      model: z.string(),
    })
    .optional(),
});

export type CompanyResearchSchema = z.infer<typeof companyResearchSchema>;

/**
 * AI-028 — the bounded persistence sink for the research provenance block.
 *
 * `aiResearch` was NOT a member of the create/update company schemas, so Zod's
 * strip semantics silently dropped the entire provenance block (receipts,
 * unknowns, contradictions, vendor capabilities, missing-evidence, and the
 * sourcing grade) at the write boundary — the AI-028 provenance output never
 * reached Firestore. This schema restores the sink.
 *
 * `data` is `.passthrough()` on purpose: the deprecated `CompanyAIResearch.data`
 * is a flexible `Record<string, unknown>`, and legacy records must round-trip
 * unchanged — known provenance fields are bounded/capped, unknown legacy keys
 * are preserved rather than dropped.
 */
const companyResearchReceiptSchema = z.object({
  url: z.string().max(2048),
  title: z.string().max(300).optional(),
  publisher: z.string().max(200).optional(),
  publishedDate: z.string().max(40).optional(),
});

export const companyResearchProvenanceSchema = z
  .object({
    receipts: z.record(z.string(), z.array(companyResearchReceiptSchema).max(5)).optional(),
    unknowns: z.array(z.string().max(120)).max(60).optional(),
    contradictions: z
      .array(
        z.object({
          field: z.string().max(120),
          values: z.array(z.string().max(300)).max(5),
          sources: z.array(companyResearchReceiptSchema).max(5).default([]),
        })
      )
      .max(20)
      .optional(),
    vendorCapabilities: z
      .array(
        z.object({
          name: z.string().max(160),
          status: z.enum(['available', 'announced', 'unknown']),
          sources: z.array(companyResearchReceiptSchema).max(3).default([]),
        })
      )
      .max(40)
      .optional(),
    missingEvidence: z.array(z.string().max(40)).max(10).optional(),
    competitors: z.array(z.string().max(120)).max(40).optional(),
    /**
     * AI-043 — bounded snapshot of the exact reviewed claim values keyed by the
     * same field as `receipts`. Lets the human source-review workflow bind a
     * decision to the exact value it approved; a legacy draft without this is
     * explicitly unreviewable.
     */
    claimValues: z.record(z.string(), z.string().max(8000)).optional(),
    /** Monotonic-ish structured-artifact version for review binding. */
    version: z.number().optional(),
    /** Every evidence category carries at least one offered (unverified) citation. */
    sourcingComplete: z.boolean().optional(),
    /** Always false: receipts are model-offered, never fetched or verified. */
    citationsVerified: z.literal(false).optional(),
  })
  .passthrough();

export const aiResearchSchema = z.object({
  lastResearched: z.number(),
  data: companyResearchProvenanceSchema,
});

export type CompanyResearchProvenance = z.infer<typeof companyResearchProvenanceSchema>;

// Read compatibility only. Historical `aiResearch.data` was an unversioned
// record and may contain fields that the canonical write schema now forbids.
// Never reuse this permissive shape at a create/update boundary.
const legacyAiResearchReadSchema = z.object({
  lastResearched: z.number(),
  data: z.record(z.any()),
});

// ============================================================================
// MAIN SCHEMAS
// ============================================================================

/**
 * Full Company schema.
 */
export const companySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  logo: z.string().optional(),
  website: z.string().url().or(z.literal('')),
  type: z.array(companyTypeSchema).min(1),
  industry: z.array(companyIndustrySchema).default([]),
  industryCustom: z.array(z.string()).optional(),
  size: companySizeSchema.optional(),
  stage: companyStageSchema.optional(),
  location: companyLocationSchema,
  status: companyStatusSchema,
  tags: z.array(z.string()).default([]),
  socialLinks: companySocialLinksSchema.default({}),
  fundingInfo: companyFundingSchema.optional(),
  technologyStack: z.array(z.string()).default([]),
  documents: z.array(companyDocumentSchema).default([]),
  aiResearch: legacyAiResearchReadSchema.optional(),
  research: companyResearchSchema.optional(),
  swot: z
    .object({
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      opportunities: z.array(z.string()),
      threats: z.array(z.string()),
    })
    .optional(),
  source: z
    .object({
      type: z.enum(['agent', 'signal']),
      agentId: z.string().optional(),
      agentName: z.string().optional(),
      signalId: z.string().optional(),
      taskTemplate: z.string().optional(),
      createdAt: z.number(),
    })
    .optional(),
  aiMetadata: z
    .object({
      relevanceScore: z.number().optional(),
      discoveredAt: z.number().optional(),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type CompanySchema = z.infer<typeof companySchema>;

/**
 * Schema for creating a new Company.
 * Excludes auto-generated fields.
 */
export const createCompanySchema = z.object({
  name: z.string().min(1, 'Company name is required'),
  description: z.string().default(''),
  logo: z.string().optional(),
  website: z.string().url('Invalid website URL').or(z.literal('')),
  type: z.array(companyTypeSchema).min(1, 'At least one company type is required'),
  industry: z.array(companyIndustrySchema).default([]),
  industryCustom: z.array(z.string()).optional(),
  size: companySizeSchema.optional(),
  stage: companyStageSchema.optional(),
  location: companyLocationSchema.default({ city: '', country: '' }),
  status: companyStatusSchema.default('Watching'),
  tags: z.array(z.string()).default([]),
  socialLinks: companySocialLinksSchema.default({}),
  fundingInfo: companyFundingSchema.optional(),
  technologyStack: z.array(z.string()).default([]),
});

export type CreateCompanySchema = z.infer<typeof createCompanySchema>;

/**
 * Schema for updating a Company.
 * All fields are optional.
 */
export const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  logo: z.string().nullable().optional(),
  website: z.string().url().or(z.literal('')).optional(),
  type: z.array(companyTypeSchema).min(1).optional(),
  industry: z.array(companyIndustrySchema).optional(),
  industryCustom: z.array(z.string()).nullable().optional(),
  size: companySizeSchema.optional(),
  stage: companyStageSchema.optional(),
  location: companyLocationSchema.optional(),
  status: companyStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  socialLinks: companySocialLinksSchema.optional(),
  fundingInfo: companyFundingSchema.nullable().optional(),
  technologyStack: z.array(z.string()).optional(),
  research: companyResearchSchema.nullable().optional(),
  swot: z
    .object({
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      opportunities: z.array(z.string()),
      threats: z.array(z.string()),
    })
    .nullable()
    .optional(),
});

export type UpdateCompanySchema = z.infer<typeof updateCompanySchema>;

// ============================================================================
// NORMALIZED SCHEMAS (with z.preprocess)
// These schemas automatically normalize legacy values to canonical values.
// Use these at write boundaries (service layer) to ensure data consistency.
// ============================================================================

/**
 * Schema for creating a Company with automatic normalization.
 * Converts legacy enum values (e.g., "Vendor" -> "corporate") automatically.
 * Use this in service layer for all company creation.
 */
export const createCompanySchemaWithNormalize = z.object({
  name: z.string().min(1, 'Company name is required'),
  description: z.string().default(''),
  logo: z.string().optional(),
  website: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? '' : val),
    z.string().url('Invalid website URL').or(z.literal(''))
  ),
  type: z.preprocess(
    (val) => (Array.isArray(val) ? val.map(normalizeCompanyType).filter(Boolean) : []),
    z.array(companyTypeSchema).min(1, 'At least one company type is required')
  ),
  industry: z.preprocess(
    (val) => (Array.isArray(val) ? val.map(normalizeCompanyIndustry).filter(Boolean) : []),
    z.array(companyIndustrySchema).default([])
  ),
  industryCustom: z.array(z.string()).optional(),
  // AI-028 — abstain instead of defaulting. When research could not source the
  // value it is absent, and stays absent, rather than being coerced to
  // `small` / `seed` (a fabricated finding). An explicit value is still normalized.
  size: z.preprocess(
    (val) => (val === undefined ? undefined : normalizeCompanySize(val)),
    companySizeSchema.optional()
  ),
  stage: z.preprocess(
    (val) => (val === undefined ? undefined : normalizeCompanyStage(val)),
    companyStageSchema.optional()
  ),
  location: companyLocationSchema.default({ city: '', country: '' }),
  status: companyStatusSchema.default('Watching'),
  tags: z.array(z.string()).default([]),
  socialLinks: companySocialLinksSchema.default({}),
  fundingInfo: companyFundingSchema.optional(),
  technologyStack: z.array(z.string()).default([]),
  aiResearch: aiResearchSchema.optional(),
});

export type CreateCompanySchemaWithNormalize = z.infer<typeof createCompanySchemaWithNormalize>;

/**
 * Schema for updating a Company with automatic normalization.
 * Converts legacy enum values automatically for partial updates.
 * Use this in service layer for all company updates.
 */
export const updateCompanySchemaWithNormalize = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  logo: z.string().nullable().optional(),
  website: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? '' : val),
    z.string().url().or(z.literal('')).optional()
  ),
  type: z.preprocess(
    (val) => (val === undefined ? undefined : Array.isArray(val) ? val.map(normalizeCompanyType).filter(Boolean) : []),
    z.array(companyTypeSchema).min(1).optional()
  ),
  industry: z.preprocess(
    (val) =>
      val === undefined ? undefined : Array.isArray(val) ? val.map(normalizeCompanyIndustry).filter(Boolean) : [],
    z.array(companyIndustrySchema).optional()
  ),
  industryCustom: z.array(z.string()).nullable().optional(),
  size: z.preprocess(
    (val) => (val === undefined ? undefined : normalizeCompanySize(val)),
    companySizeSchema.optional()
  ),
  stage: z.preprocess(
    (val) => (val === undefined ? undefined : normalizeCompanyStage(val)),
    companyStageSchema.optional()
  ),
  location: companyLocationSchema.optional(),
  status: companyStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  socialLinks: companySocialLinksSchema.optional(),
  fundingInfo: companyFundingSchema.nullable().optional(),
  technologyStack: z.array(z.string()).optional(),
  research: companyResearchSchema.nullable().optional(),
  swot: z
    .object({
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      opportunities: z.array(z.string()),
      threats: z.array(z.string()),
    })
    .nullable()
    .optional(),
  aiResearch: aiResearchSchema.optional(),
});

export type UpdateCompanySchemaWithNormalize = z.infer<typeof updateCompanySchemaWithNormalize>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate data for creating a Company.
 * @throws ZodError if validation fails
 */
export function validateCreateCompany(data: unknown): CreateCompanySchema {
  return createCompanySchema.parse(data);
}

/**
 * Validate data for updating a Company.
 * @throws ZodError if validation fails
 */
export function validateUpdateCompany(data: unknown): UpdateCompanySchema {
  return updateCompanySchema.parse(data);
}

/**
 * Safe validation for creating a Company.
 * Returns success/error instead of throwing.
 */
export function safeValidateCreateCompany(data: unknown): {
  success: boolean;
  data?: CreateCompanySchema;
  error?: z.ZodError;
} {
  const result = createCompanySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for updating a Company.
 * Returns success/error instead of throwing.
 */
export function safeValidateUpdateCompany(data: unknown): {
  success: boolean;
  data?: UpdateCompanySchema;
  error?: z.ZodError;
} {
  const result = updateCompanySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validate and NORMALIZE data for creating a Company.
 * Converts legacy enum values automatically.
 * Use this in service layer write operations.
 * @throws ZodError if validation fails after normalization
 */
export function validateCreateCompanyWithNormalize(data: unknown): CreateCompanySchemaWithNormalize {
  return createCompanySchemaWithNormalize.parse(data);
}

/**
 * Validate and NORMALIZE data for updating a Company.
 * Converts legacy enum values automatically.
 * Use this in service layer write operations.
 * @throws ZodError if validation fails after normalization
 */
export function validateUpdateCompanyWithNormalize(data: unknown): UpdateCompanySchemaWithNormalize {
  return updateCompanySchemaWithNormalize.parse(data);
}

/**
 * Safe validation with normalization for creating a Company.
 * Returns success/error instead of throwing.
 */
export function safeValidateCreateCompanyWithNormalize(data: unknown): {
  success: boolean;
  data?: CreateCompanySchemaWithNormalize;
  error?: z.ZodError;
} {
  const result = createCompanySchemaWithNormalize.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation with normalization for updating a Company.
 * Returns success/error instead of throwing.
 */
export function safeValidateUpdateCompanyWithNormalize(data: unknown): {
  success: boolean;
  data?: UpdateCompanySchemaWithNormalize;
  error?: z.ZodError;
} {
  const result = updateCompanySchemaWithNormalize.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ============================================================================
// CONSTANTS FOR UI
// ============================================================================

/**
 * Labels for company types (for UI display).
 */
export const COMPANY_TYPE_LABELS: Record<CompanyTypeValue, string> = {
  startup: 'Startup',
  scaleup: 'Scaleup',
  sme: 'SME',
  corporate: 'Corporate',
  spinoff: 'Spin-off',
  joint_venture: 'Joint Venture',
  research: 'Research Institution',
  accelerator: 'Accelerator/Incubator',
  venture_studio: 'Venture Studio',
  consultancy: 'Consultancy',
  government: 'Government',
  ngo: 'NGO',
  consortium: 'Consortium',
  academic: 'Academic Institution',
};

/**
 * Labels for company sizes (for UI display).
 */
export const COMPANY_SIZE_LABELS: Record<CompanySizeValue, string> = {
  micro: 'Micro (1-9)',
  small: 'Small (10-49)',
  medium: 'Medium (50-249)',
  large: 'Large (250-999)',
  enterprise: 'Enterprise (1000+)',
};

/**
 * Labels for company stages (for UI display).
 */
export const COMPANY_STAGE_LABELS: Record<CompanyStageValue, string> = {
  pre_seed: 'Pre-seed',
  seed: 'Seed',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c_plus: 'Series C+',
  bootstrapped: 'Bootstrapped',
  private: 'Private',
  public: 'Public',
  ipo: 'IPO',
  nonprofit: 'Non-profit',
};

/**
 * Labels for company industries (for UI display).
 */
export const COMPANY_INDUSTRY_LABELS: Record<CompanyIndustryValue, string> = {
  healthcare: 'Healthcare & Life Sciences',
  food_agriculture: 'Food & Agriculture',
  technology: 'Technology & Software',
  manufacturing: 'Manufacturing & Industrial',
  energy: 'Energy & Environment',
  consumer: 'Consumer & Retail',
  financial: 'Financial Services',
  logistics: 'Logistics & Infrastructure',
  media: 'Media & Entertainment',
  professional: 'Professional Services',
  defense: 'Defense & Aerospace',
  education: 'Education & EdTech',
  real_estate: 'Real Estate & PropTech',
  telecommunications: 'Telecommunications',
  automotive: 'Automotive & Mobility',
  chemicals: 'Chemicals & Materials',
  other: 'Other',
};

/**
 * Labels for company status (for UI display).
 */
export const COMPANY_STATUS_LABELS: Record<CompanyStatusValue, string> = {
  Watching: 'Watching',
  Contacted: 'Contacted',
  Partner: 'Partner',
  Rejected: 'Rejected',
};

/**
 * Options arrays for form selects.
 */
export const COMPANY_TYPE_OPTIONS = Object.entries(COMPANY_TYPE_LABELS).map(([value, label]) => ({
  value: value as CompanyTypeValue,
  label,
}));

export const COMPANY_SIZE_OPTIONS = Object.entries(COMPANY_SIZE_LABELS).map(([value, label]) => ({
  value: value as CompanySizeValue,
  label,
}));

export const COMPANY_STAGE_OPTIONS = Object.entries(COMPANY_STAGE_LABELS).map(([value, label]) => ({
  value: value as CompanyStageValue,
  label,
}));

export const COMPANY_INDUSTRY_OPTIONS = Object.entries(COMPANY_INDUSTRY_LABELS).map(([value, label]) => ({
  value: value as CompanyIndustryValue,
  label,
}));

export const COMPANY_STATUS_OPTIONS = Object.entries(COMPANY_STATUS_LABELS).map(([value, label]) => ({
  value: value as CompanyStatusValue,
  label,
}));
