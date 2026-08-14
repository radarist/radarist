/**
 * @file mcp/resource-uris.ts
 * @description Pure parse/build for the `radarist://` resource URI grammar.
 *
 * This is a FROZEN forward contract (Wave 0). The grammar:
 *
 *   radarist://memory/episodes/{userId}          — per-user temporal memory
 *   radarist://memory/interest-profile/{userId}  — per-user interest profile
 *   radarist://memory/insights/{userId}          — per-user proactive insights
 *   radarist://memory/sessions/{userId}          — per-user session memory
 *   radarist://graph/community-reports?q={query} — SHARED/global (no userId)
 *   radarist://skill/{name}@{version}            — skill manifest entry
 *
 * All functions are pure: no IO, no Firestore, no Neo4j. The owner/ACL check
 * for the per-user URIs lives in `resources.ts` (Lane D), NOT here — this
 * module only knows how to read and write the wire form.
 *
 * @author Radarist Team
 * @created 2026-06-26
 */

// ============================================================================
// Grammar constants
// ============================================================================

/** The fixed scheme + authority separator for every Radarist resource URI. */
export const RADARIST_URI_PREFIX = 'radarist://';

/** The four per-user memory resource kinds. */
export const MEMORY_RESOURCE_KINDS = ['episodes', 'interest-profile', 'insights', 'sessions'] as const;

export type MemoryResourceKind = (typeof MEMORY_RESOURCE_KINDS)[number];

// ============================================================================
// Parsed-URI discriminated union
// ============================================================================

/** A per-user memory resource: `radarist://memory/{kind}/{userId}`. */
export interface MemoryResourceUri {
  scheme: 'memory';
  kind: MemoryResourceKind;
  userId: string;
}

/**
 * The shared community-reports resource:
 * `radarist://graph/community-reports?q={query}`.
 *
 * Intentionally carries NO userId — community reports are global/shared
 * (`queryCommunityReports` is a global reader). The `query` is the search
 * string used to retrieve the relevant reports.
 */
export interface GraphCommunityReportsUri {
  scheme: 'graph';
  kind: 'community-reports';
  query: string;
}

/** A skill manifest entry: `radarist://skill/{name}@{version}`. */
export interface SkillResourceUri {
  scheme: 'skill';
  name: string;
  version: string;
}

export type ParsedResourceUri = MemoryResourceUri | GraphCommunityReportsUri | SkillResourceUri;

// ============================================================================
// Error
// ============================================================================

/**
 * Thrown when a string is not a valid `radarist://` resource URI, or when a
 * `ParsedResourceUri` object is structurally invalid for `buildUri`.
 */
export class InvalidResourceUriError extends Error {
  public readonly uri: string;

  constructor(uri: string, reason: string) {
    super(`Invalid radarist resource URI: ${reason} (received: ${JSON.stringify(uri)})`);
    this.name = 'InvalidResourceUriError';
    this.uri = uri;
  }
}

// ============================================================================
// Internal helpers (pure)
// ============================================================================

function isMemoryKind(value: string): value is MemoryResourceKind {
  return (MEMORY_RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Split a `path?query` tail into `[path, rawQuery | undefined]`. Only the
 * first `?` is significant; everything after it (including further `?`) is the
 * raw query string.
 */
function splitQuery(tail: string): [string, string | undefined] {
  const idx = tail.indexOf('?');
  if (idx === -1) return [tail, undefined];
  return [tail.slice(0, idx), tail.slice(idx + 1)];
}

/** Extract the `q` value from a raw query string, URL-decoded. */
function extractQ(rawQuery: string, uri: string): string {
  const params = rawQuery.split('&');
  for (const pair of params) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key === 'q') {
      const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        return decodeURIComponent(rawValue);
      } catch {
        throw new InvalidResourceUriError(uri, 'malformed percent-encoding in q parameter');
      }
    }
  }
  throw new InvalidResourceUriError(uri, 'community-reports requires a "q" query parameter');
}

// ============================================================================
// parseUri
// ============================================================================

/**
 * Parse a `radarist://` resource URI into its structured form.
 *
 * @throws {InvalidResourceUriError} if the URI does not match the grammar.
 */
export function parseUri(uri: string): ParsedResourceUri {
  if (typeof uri !== 'string' || !uri.startsWith(RADARIST_URI_PREFIX)) {
    throw new InvalidResourceUriError(
      typeof uri === 'string' ? uri : String(uri),
      `must start with "${RADARIST_URI_PREFIX}"`
    );
  }

  const tail = uri.slice(RADARIST_URI_PREFIX.length);
  const [path, rawQuery] = splitQuery(tail);
  const segments = path.split('/');
  const authority = segments[0];

  switch (authority) {
    case 'memory': {
      // radarist://memory/{kind}/{userId}
      if (segments.length !== 3) {
        throw new InvalidResourceUriError(uri, 'memory URI must be memory/{kind}/{userId}');
      }
      const kind = segments[1];
      const userId = segments[2];
      if (!isMemoryKind(kind)) {
        throw new InvalidResourceUriError(
          uri,
          `unknown memory kind "${kind}" (expected one of ${MEMORY_RESOURCE_KINDS.join(', ')})`
        );
      }
      if (!userId) {
        throw new InvalidResourceUriError(uri, 'memory URI requires a non-empty userId');
      }
      if (rawQuery !== undefined) {
        throw new InvalidResourceUriError(uri, 'memory URI does not accept a query string');
      }
      return { scheme: 'memory', kind, userId: decodeURIComponent(userId) };
    }

    case 'graph': {
      // radarist://graph/community-reports?q={query}
      if (segments.length !== 2 || segments[1] !== 'community-reports') {
        throw new InvalidResourceUriError(uri, 'graph URI must be graph/community-reports?q={query}');
      }
      if (rawQuery === undefined) {
        throw new InvalidResourceUriError(uri, 'community-reports requires a "q" query parameter');
      }
      return { scheme: 'graph', kind: 'community-reports', query: extractQ(rawQuery, uri) };
    }

    case 'skill': {
      // radarist://skill/{name}@{version}
      if (segments.length !== 2) {
        throw new InvalidResourceUriError(uri, 'skill URI must be skill/{name}@{version}');
      }
      if (rawQuery !== undefined) {
        throw new InvalidResourceUriError(uri, 'skill URI does not accept a query string');
      }
      const at = segments[1].lastIndexOf('@');
      if (at <= 0 || at === segments[1].length - 1) {
        throw new InvalidResourceUriError(uri, 'skill URI must be skill/{name}@{version}');
      }
      const name = decodeURIComponent(segments[1].slice(0, at));
      const version = decodeURIComponent(segments[1].slice(at + 1));
      return { scheme: 'skill', name, version };
    }

    default:
      throw new InvalidResourceUriError(uri, `unknown authority "${authority}" (expected memory, graph, or skill)`);
  }
}

// ============================================================================
// buildUri
// ============================================================================

/**
 * Build the canonical `radarist://` URI for a structured resource reference.
 *
 * `buildUri(parseUri(x)) === x` for any canonical URI; `parseUri(buildUri(p))`
 * deep-equals `p` for any valid `p`.
 *
 * @throws {InvalidResourceUriError} if `parts` is structurally invalid.
 */
export function buildUri(parts: ParsedResourceUri): string {
  switch (parts.scheme) {
    case 'memory': {
      if (!isMemoryKind(parts.kind)) {
        throw new InvalidResourceUriError(String(parts.kind), 'unknown memory kind');
      }
      if (!parts.userId) {
        throw new InvalidResourceUriError('', 'memory URI requires a non-empty userId');
      }
      return `${RADARIST_URI_PREFIX}memory/${parts.kind}/${encodeURIComponent(parts.userId)}`;
    }

    case 'graph': {
      // `kind` is the literal 'community-reports' by construction; the URI is
      // canonical regardless of `query` (empty queries are permitted on build).
      return `${RADARIST_URI_PREFIX}graph/community-reports?q=${encodeURIComponent(parts.query)}`;
    }

    case 'skill': {
      if (!parts.name) {
        throw new InvalidResourceUriError('', 'skill URI requires a non-empty name');
      }
      if (!parts.version) {
        throw new InvalidResourceUriError('', 'skill URI requires a non-empty version');
      }
      return `${RADARIST_URI_PREFIX}skill/${encodeURIComponent(parts.name)}@${encodeURIComponent(parts.version)}`;
    }

    default: {
      // Exhaustiveness guard — unreachable under the type system.
      const _exhaustive: never = parts;
      throw new InvalidResourceUriError(String(_exhaustive), 'unknown resource scheme');
    }
  }
}
