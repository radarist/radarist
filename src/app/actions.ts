'use server';

import { createLogger } from '@/lib/logger';
import { suggestTags } from '@/ai/flows/suggest-tags';

const log = createLogger('server-actions');
import type { SuggestTagsInput, SuggestTagsOutput } from '@/ai/flows/suggest-tags';
import { exploreTechnologies } from '@/ai/flows/explore-technologies';
import type { ExploreTechnologiesInput, ExploreTechnologiesOutput } from '@/ai/flows/explore-technologies';
import { deepResearch, deepResearchStructured } from '@/ai/flows/deep-research';
import type { DeepResearchInput, DeepResearchOutput, StructuredDeepResearchOutput } from '@/ai/flows/deep-research';
import { adminGetTechnologyById, adminUpdateTechnology } from '@/lib/technology-admin';
import { autoFillEntry } from '@/ai/flows/auto-fill-entry';
import type { AutoFillEntryInput, AutoFillEntryOutput } from '@/ai/flows/auto-fill-entry';

/**
 * Server action to suggest tags for a radar entry.
 * Wraps the `suggestTags` AI flow.
 *
 * @param input - The quadrant and content of the entry.
 * @returns Suggested tags.
 */
export async function suggestTagsAction(input: SuggestTagsInput): Promise<SuggestTagsOutput> {
  try {
    const result = await suggestTags(input);
    return result;
  } catch (error) {
    log.error('Error suggesting tags', error instanceof Error ? error : new Error(String(error)));
    return { tags: [] };
  }
}

/**
 * Server action to explore technologies based on a query.
 * Wraps the `exploreTechnologies` AI flow.
 *
 * @param input - The search query.
 * @returns Discovered technologies.
 */
export async function exploreTechnologiesAction(input: ExploreTechnologiesInput): Promise<ExploreTechnologiesOutput> {
  try {
    const result = await exploreTechnologies(input);
    return result;
  } catch (error) {
    log.error('Error exploring technologies', error instanceof Error ? error : new Error(String(error)));
    return { technologies: [] };
  }
}

/**
 * Server action to perform deep research on a technology.
 * Wraps the `deepResearch` AI flow.
 *
 * @param input - The technology details.
 * @returns Detailed analysis.
 */
export async function deepResearchAction(input: DeepResearchInput): Promise<DeepResearchOutput> {
  try {
    const result = await deepResearch(input);
    return result;
  } catch (error) {
    log.error('Error performing deep research', error instanceof Error ? error : new Error(String(error)));
    return { analysis: 'Could not retrieve analysis at this time.' };
  }
}

/**
 * Input for structured deep research with persistence (Phase 0 Task 0.2.3).
 */
export interface DeepResearchWithPersistInput extends DeepResearchInput {
  /** Technology ID to persist the research to. */
  technologyId: string;
}

/**
 * Result of structured deep research with persistence.
 */
export interface DeepResearchWithPersistResult {
  /** Whether the research was successful. */
  success: boolean;
  /** The structured research data (if successful). */
  data?: StructuredDeepResearchOutput;
  /** Error message (if failed). */
  error?: string;
}

/**
 * Server action to perform structured deep research and persist to Technology entity.
 * Phase 0 Task 0.2.3 - Saves DeepResearchData to Technology.deepResearch field.
 *
 * @param input - Technology details and ID for persistence.
 * @returns Result with structured research data.
 */
export async function deepResearchWithPersistAction(
  input: DeepResearchWithPersistInput
): Promise<DeepResearchWithPersistResult> {
  try {
    // Verify technology exists
    const technology = await adminGetTechnologyById(input.technologyId);
    if (!technology) {
      return {
        success: false,
        error: `Technology with ID ${input.technologyId} not found`,
      };
    }

    // Perform structured research
    const researchData = await deepResearchStructured({
      technologyName: input.technologyName,
      technologyDescription: input.technologyDescription,
      strategyContext: input.strategyContext,
    });

    if (!researchData) {
      return {
        success: false,
        error: 'Failed to generate structured research data',
      };
    }

    // Persist to Technology entity
    await adminUpdateTechnology(input.technologyId, {
      deepResearch: researchData,
    });

    return {
      success: true,
      data: researchData,
    };
  } catch (error) {
    log.error('Error in deepResearchWithPersistAction', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Server action to auto-fill a radar entry's details.
 * Wraps the `autoFillEntry` AI flow.
 *
 * @param input - Basic entry info.
 * @returns Complete entry metadata.
 */
export async function autoFillEntryAction(input: AutoFillEntryInput): Promise<AutoFillEntryOutput | null> {
  try {
    const result = await autoFillEntry(input);
    return result;
  } catch (error) {
    log.error('Error auto-filling entry', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

import { researchCompany } from '@/ai/flows/research-company';
import type { ResearchCompanyInput, ResearchCompanyOutput } from '@/ai/flows/research-company';
import { suggestCompanies } from '@/ai/flows/suggest-companies';
import type { SuggestCompaniesInput, SuggestCompaniesOutput } from '@/ai/flows/suggest-companies';

/**
 * Server action to research a company.
 * Wraps the `researchCompany` AI flow.
 *
 * @param input - Company name and website.
 * @returns Structured company data.
 */
export async function researchCompanyAction(input: ResearchCompanyInput): Promise<ResearchCompanyOutput | null> {
  try {
    const result = await researchCompany(input);
    return result;
  } catch (error) {
    log.error('Error researching company', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Server action to suggest companies for a technology.
 * Wraps the `suggestCompanies` AI flow.
 *
 * @param input - Technology name and context.
 * @returns List of suggested companies.
 */
export async function suggestCompaniesAction(input: SuggestCompaniesInput): Promise<SuggestCompaniesOutput | null> {
  try {
    const result = await suggestCompanies(input);
    return result;
  } catch (error) {
    log.error('Error suggesting companies', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}
