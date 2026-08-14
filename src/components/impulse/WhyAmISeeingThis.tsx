/**
 * @file WhyAmISeeingThis.tsx
 * @description Renders the breadcrumb that tells a user how an insight
 * landed in their briefing.
 *
 * Three render modes:
 *
 *   1. **Structured (preferred)** — when A.0's path data is present
 *      (`relationshipTypes` + `pathLength` + at least one endpoint
 *      entity), assemble a sentence with the explored end, the relative
 *      explore date if known (`exploredAt`), the relationship chain, and
 *      the observed end. This is the high-signal path post-A.0.
 *
 *   2. **Watch provenance** — Interest Watch insights carry no path data
 *      (they come from an AgentObservation about a single entity), so the
 *      structured sentence can't be built. Instead of echoing the summary
 *      (UX-048: it is already rendered directly above this component),
 *      state the user-scoped provenance we DID capture: which entity the
 *      user viewed, that it is therefore on their watch list, and when the
 *      change was detected. It never asserts WHAT changed — the pipeline
 *      records that an update happened, not a diff, and inventing a change
 *      payload would be a fabrication.
 *
 *   3. **Legacy fallback** — older insights with neither path data nor a
 *      watch source. Their only rationale is free text. When that text
 *      differs from the summary already on screen it is shown, labeled as
 *      the agent's recorded rationale; when it normalizes to the SAME text
 *      (the common case, since the legacy rationale IS the summary) it is
 *      rendered once as an honest "no additional provenance" note rather
 *      than printed twice.
 *
 * The split is what makes A.0 valuable to a *future* version of the UI
 * — old insights stay readable, new insights get the richer surface.
 */

import { useId } from 'react';
import { Info } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { BriefingInsight } from '@/hooks/useBriefing';

interface WhyAmISeeingThisProps {
  insight: BriefingInsight;
  /**
   * Optional resolved entity names keyed by id. The detail-page hook
   * fetches the insight with its `relatedEntities` resolved — the
   * caller plumbs that array in. If a name isn't found, we fall back to
   * the id itself so the breadcrumb is never empty.
   */
  entityNamesById: Map<string, string>;
  /**
   * UX-048 — the summary text the caller already renders above this
   * component. Used only to suppress an exact repeat in the legacy
   * fallback. Omit it when rendering standalone (nothing to duplicate).
   */
  visibleSummary?: string;
}

function findEntityName(id: string | undefined, names: Map<string, string>): string | undefined {
  if (!id) return undefined;
  return names.get(id) ?? id;
}

/**
 * True when we have enough structured data to render the preferred
 * sentence shape. Falsy fields fall back to the legacy summary path.
 */
function hasStructuredPath(insight: BriefingInsight): boolean {
  return (
    !!insight.relationshipTypes &&
    insight.relationshipTypes.length > 0 &&
    typeof insight.pathLength === 'number' &&
    !!insight.observedEntityId &&
    !!insight.exploredEntityId
  );
}

/**
 * Interest Watch insights are produced from a single `interest-watch`
 * AgentObservation about one entity the user explored — enough for
 * user-scoped provenance, not enough for a path sentence.
 */
function isWatchSourced(insight: BriefingInsight): boolean {
  return insight.agentName === 'interest-watch' && insight.relatedEntities.length > 0;
}

/**
 * Compare rationale against the summary already on screen: case, padding,
 * internal whitespace runs and trailing punctuation are cosmetic, so two
 * strings differing only in those are the same sentence to a reader.
 */
function normalizeForComparison(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?…]+$/, '')
    .toLowerCase();
}

/** Relative time, or '' when the timestamp is missing/unparseable. */
function relativeTime(value: string | undefined): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return formatDistanceToNow(parsed, { addSuffix: true });
}

/** Shared label + optional tooltip, wired to the region for screen readers. */
function WhyHeading({ headingId, tooltip }: { headingId: string; tooltip?: string }) {
  return (
    <div className="flex items-center gap-2">
      <h3 id={headingId} className="text-sm font-medium text-foreground">
        Why am I seeing this?
      </h3>
      {tooltip && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground/70" />
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

export function WhyAmISeeingThis({ insight, entityNamesById, visibleSummary }: WhyAmISeeingThisProps) {
  const headingId = useId();

  if (!hasStructuredPath(insight)) {
    // Mode 2 — watch provenance from what was actually captured.
    if (isWatchSourced(insight)) {
      const watched = insight.relatedEntities[0];
      const watchedName = entityNamesById.get(watched.id) ?? watched.name ?? watched.id;
      const detectedAgo = relativeTime(insight.createdAt);

      return (
        <section
          role="region"
          aria-labelledby={headingId}
          data-testid="why-watch"
          className="text-sm text-muted-foreground"
        >
          <WhyHeading headingId={headingId} />
          <p className="mt-1">
            Because you viewed <span className="text-foreground">{watchedName}</span>, it&apos;s on your interest watch.
            The radar saw it was updated after your last visit{detectedAgo ? ` and flagged it ${detectedAgo}` : ''}.
            What changed wasn&apos;t captured — open it to see its current state.
          </p>
        </section>
      );
    }

    // Mode 3 — legacy free-text rationale.
    const rationale = insight.evidenceSummary ?? insight.summary;
    const duplicatesVisibleSummary =
      !!visibleSummary && normalizeForComparison(rationale) === normalizeForComparison(visibleSummary);

    return (
      <section
        role="region"
        aria-labelledby={headingId}
        data-testid="why-fallback"
        className="text-sm text-muted-foreground"
      >
        <WhyHeading
          headingId={headingId}
          tooltip="Detected before structured path data was tracked, so the agent's own rationale is all that was recorded for this insight."
        />
        <p className="mt-1">
          {duplicatesVisibleSummary
            ? 'This insight predates structured provenance tracking — no additional provenance was captured beyond the summary above.'
            : rationale}
        </p>
      </section>
    );
  }

  const observedName = findEntityName(insight.observedEntityId, entityNamesById) ?? 'an entity your agent found';
  const exploredName = findEntityName(insight.exploredEntityId, entityNamesById) ?? 'an entity you explored';

  // `exploredAt` is "best-effort" per A.0 — only show the relative time
  // phrase when we actually have a usable timestamp.
  const exploredAgo = relativeTime(insight.exploredAt);
  const exploredPhrase = exploredAgo ? `you explored ${exploredName} ${exploredAgo}` : `you explored ${exploredName}`;

  const hops = insight.pathLength === 1 ? '1 hop' : `${insight.pathLength} hops`;
  const chain =
    insight.groundingVersion === 'predicate-path-v1' && insight.evidenceSummary
      ? insight.evidenceSummary
      : insight.relationshipTypes!.join(' → ');
  const finding =
    insight.epistemicKind === 'inference'
      ? `inferred that ${observedName} may be ${hops} away`
      : `found ${observedName} ${hops} away`;

  return (
    <section role="region" aria-labelledby={headingId} data-testid="why-structured" className="text-sm">
      <WhyHeading headingId={headingId} />
      <p className="mt-1 text-muted-foreground">
        Because {exploredPhrase}. Your agent <span className="text-foreground">{insight.agentName}</span> {finding} —
        through <code className="rounded bg-muted px-1 py-0.5 text-xs">{chain}</code>.
      </p>
    </section>
  );
}
