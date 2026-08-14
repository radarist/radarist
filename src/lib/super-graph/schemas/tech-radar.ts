import { z } from 'zod';

/**
 * Matches the `QuadrantConfig` shape defined in `src/lib/types` so the radar
 * skill can consume the same data the live radar UI does. N supported = 1..8,
 * mirroring the constraint enforced by `radar-utils.ts`.
 */
export const QuadrantConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().nonnegative(),
});

export const TechRadarData = z.object({
  quadrants: z.array(QuadrantConfigSchema).min(1).max(8),
  rings: z.array(z.string()).min(2).max(5), // innermost first (e.g. Adopt, Trial, Assess, Hold)
  items: z
    .array(
      z.object({
        name: z.string(),
        quadrantId: z.string(), // references QuadrantConfig.id
        ring: z.string(), // ring NAME (matches one of `rings`), not an index
        movement: z.enum(['stable', 'in', 'out']).optional(),
      })
    )
    .min(1)
    .max(120),
  title: z.string().optional(),
});
export type TechRadarPayload = z.infer<typeof TechRadarData>;
