import { z } from 'zod';

import type { PrototypeStatus, PrototypeImpact } from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

const costBreakdownItemSchema = z.object({
  category: z.string().min(1, 'Category is required'),
  amount: z.number().min(0),
  description: z.string().optional(),
});

export const prototypeFormSchema = z.object({
  name: z.string().min(1, 'Prototype name is required'),
  description: z.string().min(1, 'Description is required'),
  status: z.enum(['Ideation', 'In Development', 'Demo Ready', 'Delivered', 'Archived']),
  targetBusinessUnit: z.string().min(1, 'Target business unit is required'),
  team: z.array(z.string()),
  presentedTo: z.array(z.string()),
  presentationDate: z.number().optional(),
  artifacts: z.object({
    demoUrl: z.string().optional(),
    repoUrl: z.string().optional(),
    demoVideo: z.string().optional(),
  }),
  impact: z.object({
    type: z.enum(['Revenue Generation', 'Cost Saving', 'Business Transformation', 'Risk Mitigation']),
    estimatedValue: z.number().min(0),
    actualValue: z.number().optional(),
    timeToImpact: z.string(),
    confidence: z.number().min(0).max(100),
    notes: z.string(),
  }),
  costs: z
    .object({
      estimated: z.number().optional(),
      actual: z.number().optional(),
      currency: z.string(),
      breakdown: z.array(costBreakdownItemSchema).optional(),
    })
    .optional(),
  jiraEpic: z.string().optional(),
});

export type PrototypeFormValues = z.infer<typeof prototypeFormSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

export const PROTOTYPE_STATUSES: PrototypeStatus[] = [
  'Ideation',
  'In Development',
  'Demo Ready',
  'Delivered',
  'Archived',
];

export const IMPACT_TYPES: PrototypeImpact['type'][] = [
  'Revenue Generation',
  'Cost Saving',
  'Business Transformation',
  'Risk Mitigation',
];

// Business Unit options are no longer a hardcoded constant — the PrototypeSheet
// sources them from live Org Units (type === 'business_unit') via
// `useBusinessUnitNames()` in `@/hooks/queries/useOrgUnits`.

export const STATUS_COLORS: Record<PrototypeStatus, string> = {
  Ideation: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
  'In Development': 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  'Demo Ready': 'bg-green-500/10 text-green-600 border-green-500/30',
  Delivered: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  Archived: 'bg-muted text-muted-foreground border-border',
};

export const COST_CATEGORIES = [
  'Development',
  'Cloud Infrastructure',
  'Licenses & Tools',
  'External Consultants',
  'Hardware',
  'Training',
  'Other',
];

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'CHF', 'GBP'];
