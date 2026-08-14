/**
 * Policy and resource limits for caller-supplied Cypher.
 *
 * This is deliberately stricter than Neo4j's READ routing mode. READ mode is a
 * routing hint, not an authorization boundary, so raw queries must pass this
 * policy and the driver-level EXPLAIN classification before execution.
 */

export const RAW_CYPHER_LIMITS = Object.freeze({
  queryBytes: 16 * 1024,
  paramsBytes: 64 * 1024,
  records: 100,
  responseBytes: 256 * 1024,
  transactionTimeoutMs: 10_000,
  wallTimeoutMs: 12_000,
});

export type CypherPolicyCode =
  | 'EMPTY_QUERY'
  | 'QUERY_TOO_LARGE'
  | 'INVALID_PARAMS'
  | 'PARAMS_TOO_LARGE'
  | 'NESTED_BLOCK_COMMENT'
  | 'UNTERMINATED_LITERAL'
  | 'MULTIPLE_STATEMENTS'
  | 'UNSUPPORTED_ROOT'
  | 'FORBIDDEN_CLAUSE'
  | 'FORBIDDEN_DYNAMIC_CYPHER';

export interface CypherPolicyDecision {
  allowed: boolean;
  code?: CypherPolicyCode;
  reason?: string;
  queryBytes: number;
  paramsBytes: number;
}

export class CypherReadPolicyError extends Error {
  readonly name = 'CypherReadPolicyError';

  constructor(
    message: string,
    readonly code: CypherPolicyCode
  ) {
    super(message);
  }
}

const FORBIDDEN_TOKENS = new Set([
  // Data and schema mutations.
  'CREATE',
  'INSERT',
  'MERGE',
  'DELETE',
  'DETACH',
  'SET',
  'REMOVE',
  'DROP',
  'FOREACH',
  // Procedures and host-touching/bulk-loading clauses.
  'CALL',
  'LOAD',
  // Query modes and graph/database selection outside the raw data surface.
  'PROFILE',
  'USE',
  // Operational and administration commands. TERMINATE is classified as a
  // read by Neo4j even though it can interrupt application work.
  'SHOW',
  'TERMINATE',
  'ALTER',
  'GRANT',
  'DENY',
  'REVOKE',
  'RENAME',
  'START',
  'STOP',
  'ENABLE',
  'DEALLOCATE',
  'REALLOCATE',
]);

const ALLOWED_ROOTS = new Set(['MATCH', 'UNWIND', 'WITH', 'RETURN']);

interface MaskedCypher {
  code: string;
  escapedIdentifiers: string[];
  nestedBlockComment: boolean;
  unterminated: boolean;
}

/**
 * Mask comments and quoted values before inspecting keywords. This keeps
 * harmless strings such as `RETURN "CREATE"` valid while turning
 * `LOAD /* comment *\/ CSV` into the detectable token sequence `LOAD CSV`.
 */
function maskQuotedValuesAndComments(input: string): MaskedCypher {
  let code = '';
  let index = 0;
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' = 'normal';
  let blockDepth = 0;
  let nestedBlockComment = false;
  let escapedIdentifier = '';
  const escapedIdentifiers: string[] = [];

  while (index < input.length) {
    const char = input[index];
    const next = input[index + 1];

    if (state === 'normal') {
      if (char === '/' && next === '/') {
        code += '  ';
        index += 2;
        state = 'line-comment';
        continue;
      }
      if (char === '/' && next === '*') {
        code += '  ';
        index += 2;
        state = 'block-comment';
        blockDepth = 1;
        continue;
      }
      if (char === "'") {
        code += ' ';
        index += 1;
        state = 'single';
        continue;
      }
      if (char === '"') {
        code += ' ';
        index += 1;
        state = 'double';
        continue;
      }
      if (char === '`') {
        code += ' ';
        index += 1;
        escapedIdentifier = '';
        state = 'backtick';
        continue;
      }

      code += char;
      index += 1;
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') {
        code += char;
        state = 'normal';
      } else {
        code += ' ';
      }
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        // Neo4j block comments are not recursive. Treating a nested opener as
        // a new level would let our policy hide tokens that Neo4j parses after
        // the first closing marker, so reject this grammar mismatch outright.
        nestedBlockComment = true;
        code += '  ';
        index += 2;
        blockDepth += 1;
        continue;
      }
      if (char === '*' && next === '/') {
        code += '  ';
        index += 2;
        blockDepth -= 1;
        if (blockDepth === 0) state = 'normal';
        continue;
      }
      code += char === '\n' || char === '\r' ? char : ' ';
      index += 1;
      continue;
    }

    if (state === 'backtick') {
      if (char === '`' && next === '`') {
        escapedIdentifier += '`';
        code += '  ';
        index += 2;
        continue;
      }
      if (char === '`') {
        escapedIdentifiers.push(escapedIdentifier);
        code += ' ';
        index += 1;
        state = 'normal';
        continue;
      }
      escapedIdentifier += char;
      code += char === '\n' || char === '\r' ? char : ' ';
      index += 1;
      continue;
    }

    const quote = state === 'single' ? "'" : '"';
    if (char === '\\') {
      code += next === undefined ? ' ' : '  ';
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (char === quote && next === quote) {
      code += '  ';
      index += 2;
      continue;
    }
    if (char === quote) {
      code += ' ';
      index += 1;
      state = 'normal';
      continue;
    }
    code += char === '\n' || char === '\r' ? char : ' ';
    index += 1;
  }

  return {
    code,
    escapedIdentifiers,
    nestedBlockComment,
    unterminated: state !== 'normal' && state !== 'line-comment',
  };
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function denied(
  code: CypherPolicyCode,
  reason: string,
  queryBytes: number,
  paramsBytes: number
): CypherPolicyDecision {
  return { allowed: false, code, reason, queryBytes, paramsBytes };
}

export function inspectCypherReadQuery(
  cypher: unknown,
  params: unknown = {}
): CypherPolicyDecision {
  if (typeof cypher !== 'string' || cypher.trim().length === 0) {
    return denied('EMPTY_QUERY', 'Cypher query must be a non-empty string.', 0, 0);
  }

  const queryBytes = new TextEncoder().encode(cypher).byteLength;
  if (queryBytes > RAW_CYPHER_LIMITS.queryBytes) {
    return denied(
      'QUERY_TOO_LARGE',
      `Cypher query exceeds the ${RAW_CYPHER_LIMITS.queryBytes}-byte limit.`,
      queryBytes,
      0
    );
  }

  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return denied('INVALID_PARAMS', 'Cypher params must be a JSON object.', queryBytes, 0);
  }

  const paramsBytes = jsonByteLength(params);
  if (paramsBytes === null) {
    return denied('INVALID_PARAMS', 'Cypher params must be JSON-serializable.', queryBytes, 0);
  }
  if (paramsBytes > RAW_CYPHER_LIMITS.paramsBytes) {
    return denied(
      'PARAMS_TOO_LARGE',
      `Cypher params exceed the ${RAW_CYPHER_LIMITS.paramsBytes}-byte limit.`,
      queryBytes,
      paramsBytes
    );
  }

  const masked = maskQuotedValuesAndComments(cypher);
  if (masked.nestedBlockComment) {
    return denied(
      'NESTED_BLOCK_COMMENT',
      'Nested block comments are not allowed in caller-supplied Cypher.',
      queryBytes,
      paramsBytes
    );
  }
  if (masked.unterminated) {
    return denied(
      'UNTERMINATED_LITERAL',
      'Cypher query contains an unterminated string, identifier, or block comment.',
      queryBytes,
      paramsBytes
    );
  }

  const withoutTrailingSemicolon = masked.code.trim().replace(/;\s*$/, '').trim();
  if (withoutTrailingSemicolon.length === 0) {
    return denied('EMPTY_QUERY', 'Cypher query must contain an executable read statement.', queryBytes, paramsBytes);
  }
  if (withoutTrailingSemicolon.includes(';')) {
    return denied(
      'MULTIPLE_STATEMENTS',
      'Only one Cypher statement is allowed.',
      queryBytes,
      paramsBytes
    );
  }

  const tokens = withoutTrailingSemicolon.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.map((token) => token.toUpperCase()) ?? [];
  let rootIndex = 0;
  if (tokens[rootIndex] === 'EXPLAIN') rootIndex += 1;

  for (const token of tokens.slice(rootIndex)) {
    if (FORBIDDEN_TOKENS.has(token)) {
      return denied(
        'FORBIDDEN_CLAUSE',
        `Cypher clause ${token} is not allowed on the raw read surface.`,
        queryBytes,
        paramsBytes
      );
    }
  }

  const root = tokens[rootIndex];
  const supportedRoot = ALLOWED_ROOTS.has(root ?? '') || (root === 'OPTIONAL' && tokens[rootIndex + 1] === 'MATCH');
  if (!supportedRoot) {
    return denied(
      'UNSUPPORTED_ROOT',
      'Only MATCH, OPTIONAL MATCH, UNWIND, WITH, RETURN, and EXPLAIN read queries are supported.',
      queryBytes,
      paramsBytes
    );
  }

  if (/\bUSING\s+PERIODIC\s+COMMIT\b/i.test(withoutTrailingSemicolon)) {
    return denied(
      'FORBIDDEN_CLAUSE',
      'USING PERIODIC COMMIT is not allowed on the raw read surface.',
      queryBytes,
      paramsBytes
    );
  }

  const invokesDynamicApoc = /\bapoc\s*\.\s*cypher\s*\./i.test(withoutTrailingSemicolon);
  const escapedDynamicApoc = masked.escapedIdentifiers.some((identifier) =>
    /\bapoc\s*\.\s*cypher\s*\./i.test(identifier)
  );
  const dynamicNamespaceParts =
    (tokens.includes('APOC') || masked.escapedIdentifiers.some((identifier) => /^apoc$/i.test(identifier))) &&
    (tokens.includes('CYPHER') || masked.escapedIdentifiers.some((identifier) => /^cypher$/i.test(identifier)));
  if (invokesDynamicApoc || escapedDynamicApoc || dynamicNamespaceParts) {
    return denied(
      'FORBIDDEN_DYNAMIC_CYPHER',
      'Dynamic APOC Cypher execution is not allowed on the raw read surface.',
      queryBytes,
      paramsBytes
    );
  }

  return { allowed: true, queryBytes, paramsBytes };
}

export function hasExplainRoot(cypher: string): boolean {
  const masked = maskQuotedValuesAndComments(cypher);
  if (masked.unterminated) return false;
  const firstToken = masked.code.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0];
  return firstToken?.toUpperCase() === 'EXPLAIN';
}

export function assertCypherReadQuery(cypher: unknown, params: unknown = {}): void {
  const decision = inspectCypherReadQuery(cypher, params);
  if (!decision.allowed) {
    throw new CypherReadPolicyError(decision.reason ?? 'Cypher query is not allowed.', decision.code ?? 'FORBIDDEN_CLAUSE');
  }
}
