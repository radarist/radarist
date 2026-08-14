'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('ai-research-company');

/**
 * Schema for the input required to research a company.
 */
const _ResearchCompanyInputSchema = z.object({
    name: z.string(),
    website: z.string().optional(),
});

export type ResearchCompanyInput = z.infer<typeof _ResearchCompanyInputSchema>;

/**
 * Schema for the output provided by the company research AI service.
 * Includes all fields needed by the UI: overview, contacts, competitors, SWOT
 */
const ResearchCompanyOutputSchema = z.object({
    // Core company information
    description: z.string().describe('Professional 2-3 sentence company description'),
    summary: z.string().optional().describe('Brief 1-sentence executive summary'),
    industry: z.array(z.string()).describe('Industries the company operates in'),
    type: z.array(z.string()).describe('Company types: Vendor, Partner, Competitor, Startup, etc.'),
    size: z.string().describe('Company size: Startup, SME, or Enterprise'),
    stage: z.string().describe('Funding stage: Seed, Series A/B/C, Public, Established'),
    location: z.object({
        city: z.string(),
        country: z.string(),
    }).describe('Company headquarters location'),
    tags: z.array(z.string()).describe('5-7 relevant tags for categorization'),
    technologyStack: z.array(z.string()).describe('Key technologies used or provided'),

    // Social links
    socialLinks: z.object({
        linkedin: z.string().optional(),
        twitter: z.string().optional(),
        github: z.string().optional(),
    }).describe('Social media and web presence URLs'),

    // Contacts
    contacts: z.array(z.object({
        name: z.string(),
        role: z.string(),
        linkedin: z.string().optional()
    })).optional().describe('Key contacts (founders, executives)'),

    // Documents - AI returns various document types, transform to our enum
    documents: z.array(z.object({
        name: z.string(),
        url: z.string(),
        // AI may return descriptive types like "report", "whitepaper" - transform to "link"
        type: z.string().optional().transform(() => "link" as const)
    })).optional().describe('Public resources (docs, whitepapers, case studies)'),

    // Competitors
    competitors: z.array(z.string()).optional().describe('Main competitors in the market'),

    // SWOT Analysis
    swot: z.object({
        strengths: z.array(z.string()).describe('Key strengths and advantages'),
        weaknesses: z.array(z.string()).describe('Key weaknesses and challenges'),
        opportunities: z.array(z.string()).describe('Market opportunities'),
        threats: z.array(z.string()).describe('Competitive threats and risks'),
    }).optional().describe('SWOT analysis of the company'),

    // Funding information
    fundingInfo: z.object({
        totalRaised: z.string().optional().describe('Total funding raised'),
        lastRound: z.string().optional().describe('Most recent funding round'),
        investors: z.array(z.string()).optional().describe('Key investors'),
    }).optional().describe('Funding and investment information'),
});

export type ResearchCompanyOutput = z.infer<typeof ResearchCompanyOutputSchema>;

/**
 * Uses Generative AI to research a company and provide structured data.
 *
 * @param input - The company name and optional website.
 * @returns A promise resolving to the researched company data.
 * @throws {Error} If the AI generation fails or returns invalid JSON.
 */
export async function researchCompany(input: ResearchCompanyInput): Promise<ResearchCompanyOutput> {
    try {
        const prompt = `You are an expert Market Researcher and Technology Analyst.

TASK: Research the company "${input.name}"${input.website ? ` (website: ${input.website})` : ''} and provide COMPLETE structured data.

CRITICAL: You MUST respond with ONLY a valid JSON object. No explanatory text before or after.

Research and provide ALL of the following fields:

1. **description**: Professional 2-3 sentence company description
2. **summary**: Brief 1-sentence executive summary
3. **industry**: Array of industries (e.g., ["Cloud Computing", "AI/ML", "Enterprise Software"])
4. **type**: Array of company types (choose from: Vendor, Partner, Competitor, Startup, SME, Enterprise, Research Institution, Consulting Firm)
5. **size**: One of: "Startup" (<50 employees), "SME" (50-500), "Enterprise" (>500)
6. **stage**: Funding stage (Seed, Series A, Series B, Series C, Public, Established, Bootstrapped)
7. **location**: Object with city and country of headquarters
8. **tags**: Array of 5-7 relevant tags for categorization
9. **technologyStack**: Array of key technologies they use or provide
10. **socialLinks**: Object with linkedin, twitter, github URLs (use null if unknown)
11. **contacts**: Array of up to 3 key people (founders, C-level) with name, role, linkedin
12. **documents**: Array of up to 3 public resources (docs, whitepapers) with name, url, type
13. **competitors**: Array of 3-5 main competitors in their market
14. **swot**: SWOT analysis with strengths, weaknesses, opportunities, threats (2-3 items each)
15. **fundingInfo**: Object with totalRaised, lastRound, investors array

EXAMPLE OUTPUT FORMAT:
{
  "description": "Acme Corp is a leading provider of cloud infrastructure solutions...",
  "summary": "Enterprise cloud infrastructure company",
  "industry": ["Cloud Computing", "Infrastructure"],
  "type": ["Vendor", "Enterprise"],
  "size": "Enterprise",
  "stage": "Public",
  "location": {"city": "San Francisco", "country": "USA"},
  "tags": ["cloud", "infrastructure", "enterprise", "saas"],
  "technologyStack": ["Kubernetes", "AWS", "Go", "Python"],
  "socialLinks": {"linkedin": "https://linkedin.com/company/acme", "twitter": "https://twitter.com/acme", "github": "https://github.com/acme"},
  "contacts": [{"name": "John Doe", "role": "CEO", "linkedin": "https://linkedin.com/in/johndoe"}],
  "documents": [{"name": "Documentation", "url": "https://docs.acme.com", "type": "link"}],
  "competitors": ["Competitor1", "Competitor2", "Competitor3"],
  "swot": {
    "strengths": ["Market leader", "Strong technology"],
    "weaknesses": ["High pricing", "Complex onboarding"],
    "opportunities": ["Growing cloud market", "AI integration"],
    "threats": ["New competitors", "Regulatory changes"]
  },
  "fundingInfo": {"totalRaised": "$100M", "lastRound": "Series C", "investors": ["Sequoia", "a16z"]}
}

NOW research "${input.name}" and return ONLY the JSON object with ALL fields populated:`;

        return await generateStructuredContent(prompt, ResearchCompanyOutputSchema, {
            model: geminiTextModel() as GeminiModel,
            useGoogleSearch: true,
            temperature: 0.2, // Lower temperature for more consistent output
            maxOutputTokens: 16384, // More tokens to avoid truncation
        });
    } catch (error) {
        log.error("Error in researchCompany", error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to research company: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
