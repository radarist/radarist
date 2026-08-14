/**
 * @file linker/prompts/v1.ts
 * @description Version 1 of the Linker Verification Prompt
 *
 * **Version History:**
 * - v1.0 (2026-01-26): Initial production prompt
 *   - Rich entity context support
 *   - Detailed relation type guidance
 *   - Conservative company-company verification rules
 *
 * @author Radarist Team
 * @created 2026-01-26
 */

import { getRelationDescription } from '../relation-ontology';
import type { LinkerCandidate, EntityContext } from '../types';
import type { EntityType, RelationType } from '@/lib/types';

// ============================================================================
// PROMPT TEMPLATE
// ============================================================================

/**
 * Static portion of the verification prompt (system context).
 * This is the template that describes the task and entity/relation types.
 */
export const VERIFICATION_PROMPT_V1 = `You are an expert at evaluating entity relationships in a technology radar and innovation management context.

## Task
Verify whether each proposed relation between entities is semantically valid and meaningful.
Use the provided entity context (descriptions, industries, categories, tags) to make informed decisions.

## Entity Types
- **Technology**: Software, hardware, platforms, frameworks, AI/ML tools
- **Company**: Businesses, startups, vendors, research organizations
- **Use Case**: Business applications, scenarios, solutions
- **Signal**: News, trends, market indicators, research findings
- **Pain Point**: Business challenges, problems, friction points

## Relation Types
- **uses**: One technology depends on or incorporates another
- **enables**: One technology makes another possible or more effective
- **competes_with**: Technologies that serve similar purposes and compete for adoption
- **integrates_with**: Technologies that work together but don't depend on each other
- **alternative_to**: Technologies that can substitute for each other
- **vendor**: Company creates/sells the technology
- **user**: Company uses/implements the technology
- **partner**: Companies actively collaborate on projects/products
- **competitor**: Companies compete for the same customers/market
- **acquired_by**: Company was purchased by another
- **invested_in**: Company has invested in another
- **customer_of**: Company buys from another
- **supplier_of**: Company sells to another
- **mentions**: Signal/document references an entity
- **solves**: Technology addresses a pain point
- **addresses**: Use case solves a pain point
- **evidences**: A concrete-evidence signal (patent, filing, paper) supports an abstract-trend signal. Direction: concrete → trend.
- **parallels**: Two signals describe the same phenomenon from different angles (different companies / domains / geographies). Symmetric.
- **narrows_to**: A broader-topic signal narrows to a specific-scope signal. Direction: broad → narrow.
- **complements**: Two use cases reinforce each other (e.g. Internal Mobility Marketplace ⇄ AI-Powered Candidate Matching). Symmetric.
- **compounds**: One pain point intensifies / aggravates another (e.g. Multi-hop Reasoning Deficits → LLM Hallucinations). Direction: cause → effect.
- **conflicts_with**: Two strategies in tension over the same scope. Symmetric.
- **engages**: An initiative engages a company as a vendor/partner. Direction: initiative → company.

## Instructions
For each candidate, evaluate using the rich context provided:

1. **Examine Entity Context**: Use the descriptions, industries, categories, and tags to understand what each entity actually is and does

2. **Verify Relationship Logic**:
   - Does this relationship make sense given what you know about both entities?
   - Is there evidence in the context that supports this relationship?
   - For Company↔Company: Do NOT assume "competitor" just from same industry. Many companies in the same industry are partners, customers, or have no relationship. Require specific evidence.
   - For Company↔Technology: Consider whether company CREATED it (vendor) vs USES it (user) - check descriptions carefully

3. **Check Relation Type**:
   - If relation is "custom", you MUST suggest the correct relation type based on context
   - For Company↔Company: choose from partner, competitor, acquired_by, invested_in, customer_of, supplier_of
   - For Company↔Technology: choose from vendor, user, invested_in
   - For Technology↔Technology: choose from uses, enables, competes_with, integrates_with, alternative_to
   - For Signal↔Signal: choose from evidences (concrete→trend), parallels (peer signals), narrows_to (broad→narrow)
   - For UseCase↔UseCase: choose complements when the two reinforce each other
   - For PainPoint↔PainPoint: choose compounds when one intensifies the other (cause→effect)
   - For Strategy↔Strategy: choose conflicts_with when two strategies contest the same scope
   - For Initiative↔Company: choose engages when the initiative uses the company as vendor/partner
   - Only leave the placeholder "custom" if NO listed verb fits the context — that signals the schema is missing a predicate, not that the relation is invalid.

4. **Assign Confidence Score (0-100)**:
   - 90-100: Clear evidence in context, obvious connection
   - 70-89: Strong logical inference from context, reasonable relationship
   - 50-69: Plausible but context doesn't strongly confirm
   - Below 50: Context contradicts or doesn't support relationship

5. **Provide Reasoning**: 1-2 sentences explaining your decision, referencing specific context that influenced it

CRITICAL: Reject candidates where:
- Entities appear to be the same thing (duplicates with different names)
- Context explicitly contradicts the proposed relationship
- No logical connection exists despite similar keywords
- Companies are assumed to be competitors without evidence

## Output format (STRICT)
Return ONLY a JSON object — no preamble, no markdown fences, no commentary.
The object MUST match this exact shape:

{
  "verifications": [
    {
      "candidateIndex": 0,
      "isValid": true,
      "confidence": 85,
      "reasoning": "short sentence",
      "relationCorrect": true,
      "suggestedRelationType": "vendor"
    }
  ]
}

Emit one entry per candidate, in order. Do not wrap the response in prose.
Begin your reply with '{'.`;

// ============================================================================
// CONTEXT FORMATTING
// ============================================================================

/**
 * Formats entity context for inclusion in the prompt.
 *
 * @param context - Entity context object
 * @param entityType - Type of entity (for context-specific formatting)
 * @returns Formatted context string
 */
function formatEntityContext(context: EntityContext | undefined, _entityType: string): string {
  if (!context) {
    return 'No additional context available';
  }

  const parts: string[] = [];

  if (context.description) {
    parts.push(`Description: ${context.description}`);
  }

  if (context.industry) {
    parts.push(`Industry: ${context.industry}`);
  }

  if (context.category) {
    parts.push(`Category: ${context.category}`);
  }

  if (context.tags && context.tags.length > 0) {
    parts.push(`Tags: ${context.tags.join(', ')}`);
  }

  if (context.summary) {
    parts.push(`Summary: ${context.summary}`);
  }

  if (context.contentSnippet) {
    parts.push(`Content: ${context.contentSnippet.slice(0, 200)}...`);
  }

  if (context.source) {
    parts.push(`Source: ${context.source}`);
  }

  return parts.length > 0 ? parts.join('\n  ') : 'No additional context available';
}

// ============================================================================
// PROMPT BUILDER
// ============================================================================

/**
 * Builds the complete verification prompt for a batch of candidates.
 *
 * @param candidates - Candidates to include in the prompt
 * @returns Complete prompt string ready for AI
 */
export function buildVerificationPromptV1(candidates: LinkerCandidate[]): string {
  const candidateDescriptions = candidates.map((c, index) => {
    const relationDesc = getRelationDescription(
      c.sourceType as EntityType,
      c.targetType as EntityType,
      c.relationType as RelationType
    );

    const sourceContextStr = formatEntityContext(c.sourceContext, c.sourceType);
    const targetContextStr = formatEntityContext(c.targetContext, c.targetType);

    return `
### Candidate ${index}

**SOURCE ENTITY**
- Name: ${c.sourceName}
- Type: ${c.sourceType}
- Context:
  ${sourceContextStr}

**TARGET ENTITY**
- Name: ${c.targetName}
- Type: ${c.targetType}
- Context:
  ${targetContextStr}

**PROPOSED RELATION**
- Type: ${c.relationType} - "${relationDesc}"
- Discovery Method: ${c.discoveryMethod}
- Evidence: ${c.evidenceSnippets?.join('; ') || 'None provided'}
- Initial Confidence: ${c.confidence}%`;
  });

  return `${VERIFICATION_PROMPT_V1}

## Candidates to Verify
${candidateDescriptions.join('\n')}`;
}
