/**
 * @file lib/build-mission-eval-composers.ts
 * @description Per-entityType evaluation-brief composers + the registry the
 * dispatcher (`composeEvaluationBrief`) routes through.
 *
 * Scope: `COMPOSERS` ships **technology** + **useCase**. A technology evaluation
 * clones + integrates + benchmarks (→ assessment channel); a useCase evaluation
 * builds the smallest feasibility slice (→ proposed-entity channel). Other
 * entityTypes remain the seam — the dispatcher throws UnsupportedEvaluationEntityError.
 *
 * Admin-SDK module (server-only path) — read via firebase-admin.
 */
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import type { SupportedEntityType } from '@/lib/schemas/proposed-entity';

const log = createLogger('build-mission-eval-composers');

interface TechDoc {
  name?: string;
  description?: string;
  category?: string;
  githubUrl?: string;
  websiteUrl?: string;
  documentationUrl?: string;
  trl?: number;
  linkedUseCases?: string[];
}
interface UseCaseDoc {
  title?: string;
  description?: string;
  problem?: string;
}

export interface ComposedEvaluation {
  /** The MISSION.md brief for the sandbox. */
  brief: string;
  /** Motivating links (E0) — written back to the graph on publish. Carries both
   * the legacy technology field AND the dimension-agnostic fields. */
  motivation: {
    sourceTechnologyId?: string;
    sourceEntityId: string;
    entityType: SupportedEntityType;
    useCaseIds: string[];
    painPointIds: string[];
    strategyIds: string[];
  };
  /** Display title for the artifact. */
  title: string;
}

export type BriefComposer = (sourceEntityId: string, opts?: { useCaseIds?: string[] }) => Promise<ComposedEvaluation>;

/** Thrown when an evaluation is requested for an entityType with no composer. */
export class UnsupportedEvaluationEntityError extends Error {
  public readonly entityType: string;
  constructor(entityType: string) {
    super(`No evaluation composer is registered for entity type '${entityType}'`);
    this.name = 'UnsupportedEvaluationEntityError';
    this.entityType = entityType;
  }
}

async function getUseCase(id: string): Promise<UseCaseDoc | null> {
  try {
    const snap = await db.collection('use-cases').doc(id).get();
    return snap.exists ? (snap.data() as UseCaseDoc) : null;
  } catch {
    return null;
  }
}

/**
 * Build an evaluation brief for a Technology. Pulls the technology + the named
 * use cases (or its linked ones) and emits a machine-checkable brief that clones
 * the real repo, integrates against the use case, benchmarks, and writes a
 * structured verdict the supervisor reads back.
 */
export async function composeTechnologyEvaluationBrief(
  technologyId: string,
  opts?: { useCaseIds?: string[] }
): Promise<ComposedEvaluation> {
  const techSnap = await db.collection('technologies').doc(technologyId).get();
  if (!techSnap.exists) {
    throw new Error(`Technology ${technologyId} not found`);
  }
  const tech = techSnap.data() as TechDoc;
  const name = tech.name ?? technologyId;

  const useCaseIds = opts?.useCaseIds?.length ? opts.useCaseIds : (tech.linkedUseCases ?? []).slice(0, 3);
  const useCases = (await Promise.all(useCaseIds.map(getUseCase))).filter(Boolean) as UseCaseDoc[];

  const repoLine = tech.githubUrl
    ? `Clone the real reference implementation: ${tech.githubUrl}`
    : `No repo URL is recorded for this technology — find the official OSS implementation, record the URL you used in the ADR, and clone it. If none exists, record that as a finding and evaluate the most credible OSS option.`;

  const useCaseBlock = useCases.length
    ? useCases
        .map(
          (uc, i) =>
            `${i + 1}. **${uc.title ?? 'Use case'}** — ${uc.problem ?? uc.description ?? '(no description on the entity)'}`
        )
        .join('\n')
    : 'No use case is linked to this technology. Evaluate it against a representative task implied by its category, and record that assumption in the ADR (gap-closing inception).';

  const docsLine = [
    tech.documentationUrl && `Docs: ${tech.documentationUrl}`,
    tech.websiteUrl && `Site: ${tech.websiteUrl}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const brief = `# Mission: Evaluate ${name}

## Objective

Produce a hands-on, evidence-grade verdict on whether **${name}** is fit for our use, by building a real integration and measuring it — not by reading marketing.

## Context

Technology under evaluation: **${name}**${tech.category ? ` (${tech.category})` : ''}.
${tech.description ?? ''}
${docsLine}
${repoLine}

This is a TECHNOLOGY EVALUATION artifact: the output is a **verdict + evidence**, not a polished app. Judge yourself on correctness and measurement, not visual design.

## Use cases to evaluate against

${useCaseBlock}

## Must have

- Clone the real OSS implementation and **integrate it genuinely** against the use case(s) above — a real working slice, not a hallucinated wrapper.
- A small but honest **benchmark** of the dimension that matters for our use (latency / throughput / footprint / integration effort) — measured, with the command recorded.
- A primary-source **maturity read**: README quality, examples, test health, last-commit recency, license, API surface.

## Out of scope

- Production hardening, auth, multi-tenant concerns, visual polish.

## Done means

- The full test suite exits 0 from a clean install.
- The benchmark runs and its numbers are recorded.
- You write **\`.impulse/verdict.json\`** with this exact shape (the supervisor reads it back):
  \`\`\`json
  {
    "trl": 1-9,
    "confidence": 0-100,
    "recommendation": "adopt | trial | assess | hold",
    "metrics": [{ "name": "...", "value": "...", "command": "..." }],
    "findings": [{ "title": "...", "detail": "...", "kind": "verdict|benchmark|risk|observation", "metric": "...", "confidence": 0-100 }],
    "summary": "one paragraph"
  }
  \`\`\`
- \`docs/05-adr.md\` records the repo you cloned and why, and any gap-closing assumptions.`;

  log.info('composed evaluation brief', {
    technologyId,
    name,
    useCaseCount: useCases.length,
    hasRepo: Boolean(tech.githubUrl),
  });

  return {
    brief,
    motivation: {
      sourceTechnologyId: technologyId,
      sourceEntityId: technologyId,
      entityType: 'technology',
      useCaseIds,
      painPointIds: [],
      strategyIds: [],
    },
    title: `Evaluate ${name}`,
  };
}

/**
 * Build an evaluation brief for a Use Case. Unlike a technology (clone + integrate +
 * benchmark), a use-case evaluation builds the SMALLEST real working slice that
 * satisfies the use case and reports a feasibility verdict. It carries NO
 * sourceTechnologyId, so the publish path routes to the proposed-ENTITY channel
 * (never the assessment one) — see resolveEvaluationPublishChannel.
 */
export async function composeUseCaseEvaluationBrief(
  useCaseId: string,
  _opts?: { useCaseIds?: string[] }
): Promise<ComposedEvaluation> {
  const snap = await db.collection('use-cases').doc(useCaseId).get();
  if (!snap.exists) {
    throw new Error(`Use case ${useCaseId} not found`);
  }
  const uc = snap.data() as UseCaseDoc;
  const name = uc.title ?? useCaseId;
  const problem = uc.problem ?? uc.description ?? '(no problem statement recorded on the entity)';
  const descLine = uc.description && uc.description !== problem ? `\nDescription: ${uc.description}` : '';

  const brief = `# Mission: Evaluate use case — ${name}

## Objective

Produce a hands-on, evidence-grade verdict on whether the use case **${name}** is *feasible and worth pursuing*, by building the smallest real working slice that satisfies it and measuring the effort — not by speculating.

## Context

Use case under evaluation: **${name}**.
Problem it addresses: ${problem}${descLine}

This is a non-technology EVALUATION artifact: the output is a **feasibility verdict + evidence**, not a polished product. Judge yourself on whether a credible OSS-based slice actually works and on the honesty of the effort/feasibility read.

## Must have

- Build the **smallest real working slice** that satisfies the core of this use case, using credible OSS building blocks (record which, and why) — a genuine working path, not a hallucinated wrapper.
- A small but honest **feasibility read**: how hard it was (effort), the critical risk, and what a production version would require — measured/observed, not asserted.
- Identify the **existing technologies/approaches** that already address this use case and how the slice compares.

## Out of scope

- Production hardening, auth, multi-tenant concerns, visual polish.

## Done means

- The slice runs and demonstrably does the core of the use case (record the command + what it produced).
- You write **\`.impulse/verdict.json\`** with this exact shape (the supervisor reads it back — \`recommendation\` MUST be one of the four enum values exactly, or the whole verdict is rejected). For a use case read them as: **adopt** = pursue/build now · **trial** = pilot a slice · **assess** = needs more validation · **hold** = not now:
  \`\`\`json
  {
    "confidence": 0-100,
    "recommendation": "adopt | trial | assess | hold",
    "metrics": [{ "name": "...", "value": "...", "command": "..." }],
    "findings": [{ "title": "...", "detail": "...", "kind": "verdict|benchmark|risk|observation", "metric": "...", "confidence": 0-100 }],
    "summary": "one paragraph: is this use case feasible + worth pursuing, and why"
  }
  \`\`\`
- \`docs/05-adr.md\` records the OSS building blocks you used and any gap-closing assumptions.`;

  log.info('composed use-case evaluation brief', { useCaseId, name });

  return {
    brief,
    motivation: {
      // No sourceTechnologyId → routes to the 'entity' publish channel, which stages an
      // `evaluates` relation (Document→this use case) via connectArtifactToGraph's
      // dimension-agnostic sourceEntityId path. The subject lives in sourceEntityId, NOT
      // useCaseIds (that array is for motivating links; here the use case IS the subject).
      sourceEntityId: useCaseId,
      entityType: 'useCase',
      useCaseIds: [],
      painPointIds: [],
      strategyIds: [],
    },
    title: `Evaluate use case: ${name}`,
  };
}

/**
 * Composer registry. Technology + Use Case ship; other entityTypes are the seam
 * (the dispatcher throws UnsupportedEvaluationEntityError for them).
 */
export const COMPOSERS: Partial<Record<SupportedEntityType, BriefComposer>> = {
  technology: composeTechnologyEvaluationBrief,
  useCase: composeUseCaseEvaluationBrief,
};
