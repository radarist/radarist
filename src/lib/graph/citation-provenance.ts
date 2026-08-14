import { citationSourceIds } from '@/lib/citation-source-ids';

export interface GraphCitationRef {
  collection: string;
  id: string;
}

export type CitationResolution = { state: 'eligible' } | { state: 'absent' } | { state: 'unavailable'; reason: string };
export type OwnerScopedCitationReader = (ref: GraphCitationRef) => Promise<CitationResolution>;
export interface CitedSource {
  id: number;
  url: string;
  title?: string;
}
export interface ResolvedCitation<S extends CitedSource = CitedSource> {
  source: S;
  ref: GraphCitationRef;
  resolution: CitationResolution;
}
export interface CitationProvenanceReport<S extends CitedSource = CitedSource> {
  eligible: S[];
  absent: ResolvedCitation<S>[];
  unavailable: ResolvedCitation<S>[];
  graphDerived: number;
}

export const AMBIGUOUS_GRAPH_COLLECTION = 'impulse-graph';
export const MALFORMED_INTERNAL_COLLECTION = 'internal-unresolved';
const INTERNAL_WITH_TYPE = /^internal:\/\/[^/]+\/([a-z-]+)\/(.+)$/i;
const INTERNAL_HOST_ONLY = /^internal:\/\/([^/]+)\/([^/].*)$/i;
const INTERNAL_SCHEME = /^internal:\/\//i;
const COLLECTION_BY_SEGMENT: Readonly<Record<string, string>> = {
  document: 'documents',
  documents: 'documents',
  signal: 'signals',
  signals: 'signals',
  technology: 'technologies',
  technologies: 'technologies',
  company: 'companies',
  companies: 'companies',
};
const COLLECTION_BY_HOST: Readonly<Record<string, string>> = {
  'impulse-graph': AMBIGUOUS_GRAPH_COLLECTION,
  'impulse-signals': 'signals',
};

/** Every internal URI is platform evidence and therefore must be resolved. */
export function parseGraphCitation(url: string): GraphCitationRef | null {
  const normalized = (url ?? '').trim();
  const typed = INTERNAL_WITH_TYPE.exec(normalized);
  if (typed) {
    return {
      collection: COLLECTION_BY_SEGMENT[typed[1]!.toLowerCase()] ?? typed[1]!.toLowerCase(),
      id: typed[2]!.trim(),
    };
  }
  const hostOnly = INTERNAL_HOST_ONLY.exec(normalized);
  if (hostOnly) {
    const host = hostOnly[1]!.toLowerCase();
    return { collection: COLLECTION_BY_HOST[host] ?? host, id: hostOnly[2]!.trim() };
  }
  if (INTERNAL_SCHEME.test(normalized)) {
    return {
      collection: MALFORMED_INTERNAL_COLLECTION,
      id: normalized.slice('internal://'.length).trim() || '(missing-reference)',
    };
  }
  return null;
}

export async function resolveGraphCitations<S extends CitedSource>(
  sources: readonly S[],
  read: OwnerScopedCitationReader
): Promise<CitationProvenanceReport<S>> {
  const report: CitationProvenanceReport<S> = { eligible: [], absent: [], unavailable: [], graphDerived: 0 };
  for (const source of sources) {
    const ref = parseGraphCitation(source.url);
    if (!ref) {
      report.eligible.push(source);
      continue;
    }
    report.graphDerived += 1;
    let resolution: CitationResolution;
    try {
      resolution = await read(ref);
    } catch (error) {
      resolution = { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
    if (resolution.state === 'eligible') report.eligible.push(source);
    else if (resolution.state === 'absent') report.absent.push({ source, ref, resolution });
    else report.unavailable.push({ source, ref, resolution });
  }
  return report;
}

export function describeWithheldCitations(report: CitationProvenanceReport): string {
  if (report.absent.length === 0 && report.unavailable.length === 0) return '';
  const lines = ['WITHHELD PLATFORM EVIDENCE — do not cite these sources.'];
  if (report.absent.length > 0) {
    lines.push(
      `Not present in the current store (${report.absent.length}): ${report.absent
        .map((entry) => `[${entry.source.id}] ${entry.ref.collection}/${entry.ref.id}`)
        .join(', ')}`
    );
  }
  if (report.unavailable.length > 0) {
    lines.push(
      `Could not be verified (${report.unavailable.length}) — unavailable, not absent: ${report.unavailable
        .map((entry) => `[${entry.source.id}] ${entry.ref.collection}/${entry.ref.id}`)
        .join(', ')}`
    );
  }
  return lines.join('\n');
}

export function filterBundleByWithheldSourceIds<
  B extends { sources: CitedSource[]; findings: string[]; unresolved: string[] },
>(bundle: B, withheldIds: ReadonlySet<number>): { bundle: B; keptFindings: number; demotedFindings: number } {
  if (withheldIds.size === 0) return { bundle, keptFindings: bundle.findings.length, demotedFindings: 0 };
  const findings: string[] = [];
  const unresolved = [...bundle.unresolved];
  for (const finding of bundle.findings) {
    const removed = citationSourceIds(finding).filter((id) => withheldIds.has(id));
    if (removed.length === 0) findings.push(finding);
    else unresolved.push(`Finding withheld because platform citation(s) did not resolve: [${removed.join(', ')}].`);
  }
  return {
    bundle: {
      ...bundle,
      sources: bundle.sources.filter((source) => !withheldIds.has(source.id)),
      findings,
      unresolved,
    },
    keptFindings: findings.length,
    demotedFindings: bundle.findings.length - findings.length,
  };
}
