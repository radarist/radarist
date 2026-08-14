/**
 * @file components/sheets/CompanySheet/constants.ts
 * @description Schema, form types, option constants, and AI research mapping helpers
 *
 * Extracted from CompanySheet.tsx during decomposition.
 */

import { z } from 'zod';

import type { CompanyType, CompanySize, CompanyStage, CompanyStatus, CompanyIndustry } from '@/lib/types';

import {
  COMPANY_TYPE_OPTIONS,
  COMPANY_SIZE_OPTIONS,
  COMPANY_STAGE_OPTIONS,
  COMPANY_INDUSTRY_OPTIONS,
  companyTypeSchema,
  companySizeSchema,
  companyStageSchema,
  companyIndustrySchema,
  type CompanyIndustryValue,
} from '@/lib/schemas/company';

// ============================================================================
// SCHEMA
// ============================================================================

export const companyFormSchema = z.object({
  name: z.string().min(1, 'Company name is required'),
  description: z.string().optional(),
  website: z.string().url('Invalid URL').or(z.literal('')),
  type: z.array(companyTypeSchema).min(1, 'Select at least one type'),
  industry: z.array(companyIndustrySchema),
  industryCustom: z.array(z.string()).optional(),
  size: companySizeSchema,
  stage: companyStageSchema,
  status: z.enum(['Watching', 'Contacted', 'Partner', 'Rejected']),
  location: z.object({
    city: z.string(),
    country: z.string(),
  }),
  tags: z.array(z.string()),
  socialLinks: z.object({
    linkedin: z.string().optional(),
    twitter: z.string().optional(),
    github: z.string().optional(),
  }),
  technologyStack: z.array(z.string()),
});

export type CompanyFormValues = z.infer<typeof companyFormSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

export const COMPANY_TYPES = COMPANY_TYPE_OPTIONS;
export const COMPANY_SIZES = COMPANY_SIZE_OPTIONS;
export const COMPANY_STAGES = COMPANY_STAGE_OPTIONS;
export const COMPANY_INDUSTRIES = COMPANY_INDUSTRY_OPTIONS;
export const COMPANY_STATUSES: CompanyStatus[] = ['Watching', 'Contacted', 'Partner', 'Rejected'];

// ============================================================================
// AI RESEARCH MAPPING HELPERS
// ============================================================================

/** Map AI research industry strings to valid enum values */
export const INDUSTRY_STRING_MAP: Record<string, CompanyIndustryValue> = {
  healthcare: 'healthcare',
  health: 'healthcare',
  medical: 'healthcare',
  'life sciences': 'healthcare',
  biotech: 'healthcare',
  pharmaceutical: 'healthcare',
  food: 'food_agriculture',
  agriculture: 'food_agriculture',
  agtech: 'food_agriculture',
  technology: 'technology',
  software: 'technology',
  tech: 'technology',
  saas: 'technology',
  'ai/ml': 'technology',
  'enterprise software': 'technology',
  manufacturing: 'manufacturing',
  industrial: 'manufacturing',
  automotive: 'manufacturing',
  aerospace: 'manufacturing',
  energy: 'energy',
  cleantech: 'energy',
  renewable: 'energy',
  environment: 'energy',
  consumer: 'consumer',
  retail: 'consumer',
  'e-commerce': 'consumer',
  ecommerce: 'consumer',
  financial: 'financial',
  fintech: 'financial',
  finance: 'financial',
  banking: 'financial',
  insurance: 'financial',
  logistics: 'logistics',
  transportation: 'logistics',
  'supply chain': 'logistics',
  infrastructure: 'logistics',
  telecommunications: 'logistics',
  media: 'media',
  entertainment: 'media',
  gaming: 'media',
  professional: 'professional',
  consulting: 'professional',
  services: 'professional',
};

export function mapIndustryStringToEnum(industry: string): CompanyIndustryValue | null {
  const normalized = industry.toLowerCase().trim();
  return INDUSTRY_STRING_MAP[normalized] || null;
}

/** Map AI size string to form enum */
export const SIZE_MAP: Record<string, CompanySize> = {
  startup: 'small',
  micro: 'micro',
  sme: 'small',
  small: 'small',
  medium: 'medium',
  large: 'large',
  enterprise: 'enterprise',
};

/** Map AI stage string to form enum */
export const STAGE_MAP: Record<string, CompanyStage> = {
  'pre-seed': 'pre_seed',
  pre_seed: 'pre_seed',
  preseed: 'pre_seed',
  seed: 'seed',
  'series a': 'series_a',
  series_a: 'series_a',
  seriesa: 'series_a',
  'series b': 'series_b',
  series_b: 'series_b',
  seriesb: 'series_b',
  'series c': 'series_c_plus',
  'series c+': 'series_c_plus',
  series_c: 'series_c_plus',
  series_c_plus: 'series_c_plus',
  'series d': 'series_c_plus',
  'series d+': 'series_c_plus',
  bootstrapped: 'bootstrapped',
  'self-funded': 'bootstrapped',
  private: 'private',
  'late stage': 'private',
  public: 'public',
  'publicly traded': 'public',
  established: 'private',
  ipo: 'ipo',
  nonprofit: 'nonprofit',
  'non-profit': 'nonprofit',
};

/** Map AI company type string to form enum */
export const TYPE_MAP: Record<string, CompanyType> = {
  startup: 'startup',
  scaleup: 'scaleup',
  'scale-up': 'scaleup',
  sme: 'sme',
  corporate: 'corporate',
  enterprise: 'corporate',
  spinoff: 'spinoff',
  'spin-off': 'spinoff',
  'joint venture': 'joint_venture',
  joint_venture: 'joint_venture',
  research: 'research',
  'research institution': 'research',
  university: 'research',
  accelerator: 'accelerator',
  incubator: 'accelerator',
  'venture studio': 'venture_studio',
  venture_studio: 'venture_studio',
  consultancy: 'consultancy',
  consulting: 'consultancy',
  'consulting firm': 'consultancy',
  // Legacy value mappings
  vendor: 'corporate',
  partner: 'corporate',
  competitor: 'corporate',
};

// Re-export types used by other modules
export type { CompanyIndustryValue };
export type { CompanyType, CompanySize, CompanyStage, CompanyStatus, CompanyIndustry };
