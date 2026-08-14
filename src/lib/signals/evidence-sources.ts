import type { Signal } from '@/lib/types';

import { canonicalHttpUrl, isUnresolvedGoogleGroundingRedirect } from './source-identity';

export const SIGNAL_EVIDENCE_VERDICTS = ['confirming', 'contradicting', 'inconclusive'] as const;

export type SignalEvidenceVerdict = (typeof SIGNAL_EVIDENCE_VERDICTS)[number];

export interface SignalEvidenceSourceInput {
  title?: string;
  url?: string;
  description?: string;
  date?: string;
  verdict?: SignalEvidenceVerdict;
}

export interface SignalGroundingCitation {
  uri: string;
  title?: string;
  /**
   * Publisher URL recovered from a trusted grounding redirect. It is used only
   * for identity matching; `uri` remains the provider-supplied navigation URL.
   */
  identityUri?: string;
}

export interface SignalEvidenceSource {
  title: string;
  url: string;
  description?: string;
  date?: string;
  verdict: SignalEvidenceVerdict;
}

export interface NormalizeSignalEvidenceOptions {
  /**
   * When present, additional evidence is restricted to these citations. This
   * turns the model's source list into annotations over grounding metadata,
   * rather than accepting model-generated URLs as evidence.
   */
  groundedCitations?: readonly SignalGroundingCitation[];
}

type SignalSourceIdentity = Pick<Signal, 'title' | 'source' | 'url'>;

interface IdentifiedEvidenceSource extends SignalEvidenceSource {
  identity: string;
}

function evidenceVerdict(value: unknown): SignalEvidenceVerdict {
  return SIGNAL_EVIDENCE_VERDICTS.includes(value as SignalEvidenceVerdict)
    ? (value as SignalEvidenceVerdict)
    : 'inconclusive';
}

function asEvidenceSource(value: unknown): SignalEvidenceSourceInput | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (typeof source.url !== 'string') return null;

  return {
    url: source.url,
    ...(typeof source.title === 'string' ? { title: source.title } : {}),
    ...(typeof source.description === 'string' ? { description: source.description } : {}),
    ...(typeof source.date === 'string' ? { date: source.date } : {}),
    verdict: evidenceVerdict(source.verdict),
  };
}

function identifyEvidenceSource(source: SignalEvidenceSourceInput): IdentifiedEvidenceSource | null {
  const url = canonicalHttpUrl(source.url);
  if (!url) return null;
  return {
    identity: url.identity,
    title: source.title?.trim() || new URL(url.displayUrl).hostname,
    url: url.displayUrl,
    ...(source.description?.trim() ? { description: source.description.trim() } : {}),
    ...(source.date?.trim() ? { date: source.date.trim() } : {}),
    verdict: evidenceVerdict(source.verdict),
  };
}

function mergeByIdentity(sources: Map<string, IdentifiedEvidenceSource>, incoming: IdentifiedEvidenceSource): void {
  const existing = sources.get(incoming.identity);
  if (!existing) {
    sources.set(incoming.identity, incoming);
    return;
  }
  if (existing.verdict !== incoming.verdict) {
    sources.set(incoming.identity, { ...existing, verdict: 'inconclusive' });
  }
}

/**
 * Build the canonical evidence set for signal scoring and persistence.
 *
 * The signal's original page is first-party evidence and therefore contributes
 * one confirming source at most. Other sources count only when they have a real
 * HTTP(S) URL and an explicit confirming verdict. Entity links and search flags
 * are intentionally outside this contract.
 */
export function normalizeSignalEvidenceSources(
  signal: SignalSourceIdentity,
  additionalSources: readonly unknown[] = [],
  options: NormalizeSignalEvidenceOptions = {}
): SignalEvidenceSource[] {
  const declaredSources = additionalSources
    .map(asEvidenceSource)
    .filter((source): source is SignalEvidenceSourceInput => source !== null)
    .map(identifyEvidenceSource)
    .filter((source): source is IdentifiedEvidenceSource => source !== null);

  const declaredByIdentity = new Map<string, IdentifiedEvidenceSource>();
  for (const source of declaredSources) mergeByIdentity(declaredByIdentity, source);

  const candidates = new Map<string, IdentifiedEvidenceSource>();
  if (options.groundedCitations === undefined) {
    for (const source of declaredByIdentity.values()) mergeByIdentity(candidates, source);
  } else {
    for (const citation of options.groundedCitations) {
      const citationUrl = canonicalHttpUrl(citation.uri);
      const citationIdentityUrl = canonicalHttpUrl(citation.identityUri ?? citation.uri);
      if (!citationUrl || !citationIdentityUrl) continue;
      // A raw Google redirect is proof that a page was consulted, but not an
      // identity that the model may self-declare as confirming. Only a direct
      // publisher citation or a separately resolved publisher identity can
      // transfer stance.
      const declared =
        citation.identityUri || !isUnresolvedGoogleGroundingRedirect(citationUrl)
          ? declaredByIdentity.get(citationIdentityUrl.identity)
          : undefined;
      const candidate = identifyEvidenceSource({
        url: citationUrl.displayUrl,
        title: citation.title || declared?.title,
        description: declared?.description,
        date: declared?.date,
        // Grounding proves consultation, not support. Only an exact canonical
        // URL match may transfer the model's stance; titles are not identities.
        verdict: declared?.verdict ?? 'inconclusive',
      });
      if (candidate) {
        // Google grounding citations are navigation redirects. Keep that URL
        // for display, but dedupe and transfer stance against the recovered
        // publisher identity when one was resolved by the trusted boundary.
        mergeByIdentity(candidates, { ...candidate, identity: citationIdentityUrl.identity });
      }
    }
  }

  const combined = new Map<string, IdentifiedEvidenceSource>();
  const originalUrl = canonicalHttpUrl(signal.url);

  if (originalUrl) {
    mergeByIdentity(combined, {
      identity: originalUrl.identity,
      title: signal.source?.trim() || signal.title?.trim() || originalUrl.displayUrl,
      url: originalUrl.displayUrl,
      verdict: 'confirming',
    });
  }

  for (const candidate of candidates.values()) {
    mergeByIdentity(combined, candidate);
  }

  return [...combined.values()].map((candidate) => ({
    title: candidate.title,
    url: candidate.url,
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.date ? { date: candidate.date } : {}),
    verdict: candidate.verdict,
  }));
}
