import { z } from 'zod';

import type { TechnologyCategory } from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

export const technologyFormSchema = z.object({
  name: z.string().min(1, 'Technology name is required'),
  description: z.string().min(1, 'Description is required'),
  category: z
    .enum([
      'framework',
      'language',
      'platform',
      'tool',
      'library',
      'service',
      'methodology',
      'infrastructure',
      'hardware',
      'standard',
      'protocol',
      'api',
      'architecture',
      'other',
    ])
    .optional(),
  trl: z.number().min(1).max(9).optional(),
  timeToImpact: z.enum(['H1', 'H2', 'H3']).optional(),
  tags: z.array(z.string()),
  websiteUrl: z.string().url('Invalid URL').or(z.literal('')).optional(),
  githubUrl: z.string().url('Invalid URL').or(z.literal('')).optional(),
  documentationUrl: z.string().url('Invalid URL').or(z.literal('')).optional(),
  linkedCompanies: z.array(z.string()),
  linkedUseCases: z.array(z.string()),
});

export type TechnologyFormValues = z.infer<typeof technologyFormSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

export const TECHNOLOGY_CATEGORIES: { value: TechnologyCategory; label: string }[] = [
  { value: 'framework', label: 'Framework' },
  { value: 'language', label: 'Language' },
  { value: 'platform', label: 'Platform' },
  { value: 'tool', label: 'Tool' },
  { value: 'library', label: 'Library' },
  { value: 'service', label: 'Service' },
  { value: 'methodology', label: 'Methodology' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'standard', label: 'Standard' },
  { value: 'protocol', label: 'Protocol' },
  { value: 'api', label: 'API' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'other', label: 'Other' },
];

export const TRL_OPTIONS = [
  { value: 1, label: 'TRL 1 - Basic principles observed' },
  { value: 2, label: 'TRL 2 - Technology concept formulated' },
  { value: 3, label: 'TRL 3 - Experimental proof of concept' },
  { value: 4, label: 'TRL 4 - Technology validated in lab' },
  { value: 5, label: 'TRL 5 - Technology validated in relevant environment' },
  { value: 6, label: 'TRL 6 - Technology demonstrated in relevant environment' },
  { value: 7, label: 'TRL 7 - System prototype demonstration' },
  { value: 8, label: 'TRL 8 - System complete and qualified' },
  { value: 9, label: 'TRL 9 - Actual system proven in operational environment' },
];

export const TIME_TO_IMPACT_OPTIONS = [
  { value: 'H1', label: 'H1 - Near-term (0-2 years)', description: 'Ready for adoption or production use' },
  { value: 'H2', label: 'H2 - Mid-term (2-5 years)', description: 'Emerging technology requiring investment' },
  { value: 'H3', label: 'H3 - Long-term (5+ years)', description: 'Research or speculative technology' },
];

export const COMMON_TAGS = [
  'frontend',
  'backend',
  'database',
  'devops',
  'ai',
  'ml',
  'cloud',
  'mobile',
  'security',
  'testing',
  'api',
  'data',
  'analytics',
  'iot',
  'blockchain',
];
