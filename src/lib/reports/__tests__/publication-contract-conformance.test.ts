/**
 * REPORT-013 — instruction/gate conformance.
 *
 * Twice now, an agent-facing instruction has mandated report output that the
 * publication gate rejects, and nothing compared the two:
 *
 *   - 2026-06-07 → 2026-07-20: the creator profile mandated remote
 *     `<img src="https://firebasestorage…">` infographics while UX-021 rejected
 *     off-origin resources. In-report images went from ~26/month to zero.
 *   - until this row: `cite-ieee` mandated `<a href="https://…">source</a>`
 *     references that the same rule rejects, so reports shipped sources the
 *     reader could not reach.
 *
 * Each was invisible because the contradiction lived between two files nobody
 * read together. This suite reads them together: every instruction actually
 * served to a report-authoring agent is scanned for example markup the gate
 * would reject. A future instruction that reintroduces either shape fails here
 * rather than silently degrading published reports.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeBasicHtmlEntities,
  findContractConformanceViolations,
  formatContractConformanceFindings,
  isProhibitionContext,
  normalizeSourceUrlText,
  PUBLICATION_CONTRACT_PROBES,
  REPORT_IMAGE_ID_ATTRIBUTE,
} from '@/lib/reports/publication-contract';
import { detectExecutableReportContent } from '@/lib/reports/publication-policy';
import { sanitizeReportHtml } from '@/lib/html-sanitizer';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function readIfPresent(relativePath: string): string | null {
  const absolute = join(REPO_ROOT, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf-8') : null;
}

/** Agent profiles and skills whose instructions shape published report HTML. */
function servedInstructionDocuments(): { label: string; source: string }[] {
  const docs: { label: string; source: string }[] = [];

  const agentsDir = join(REPO_ROOT, 'agent', 'agents');
  if (existsSync(agentsDir)) {
    for (const agent of readdirSync(agentsDir)) {
      const source = readIfPresent(join('agent', 'agents', agent, 'PROFILE.md'));
      if (source) docs.push({ label: `agent/agents/${agent}/PROFILE.md`, source });
    }
  }

  const skillsDir = join(REPO_ROOT, 'agent', 'runtime-plugin', 'skills');
  if (existsSync(skillsDir)) {
    for (const skill of readdirSync(skillsDir)) {
      const source = readIfPresent(join('agent', 'runtime-plugin', 'skills', skill, 'SKILL.md'));
      if (source) docs.push({ label: `agent/runtime-plugin/skills/${skill}/SKILL.md`, source });
    }
  }

  // The generated blob is what missions are actually served, so it is scanned
  // in its own right — a stale generation cannot hide a fixed source file.
  const generated = readIfPresent(join('src', 'lib', 'mcp', 'generated', 'skill-prompts.ts'));
  if (generated) docs.push({ label: 'src/lib/mcp/generated/skill-prompts.ts', source: generated });

  return docs;
}

describe('served instructions conform to the publication contract', () => {
  const documents = servedInstructionDocuments();

  it('finds the instruction surfaces it claims to police', () => {
    expect(documents.length).toBeGreaterThan(5);
    expect(documents.map((d) => d.label)).toContain('agent/agents/creator/PROFILE.md');
    expect(documents.map((d) => d.label)).toContain('agent/runtime-plugin/skills/cite-ieee/SKILL.md');
  });

  it.each(documents.map((d) => [d.label, d.source] as const))(
    '%s mandates no output the publication gate rejects',
    (label, source) => {
      const findings = findContractConformanceViolations(source);
      expect(formatContractConformanceFindings(label, findings)).toBe(
        `${label} mandates report output the publication gate rejects:`
      );
    }
  );
});

// ---------------------------------------------------------------------------
// REPORT-016 — a served instruction may not name a symbol that does not exist.
//
// The same stale-doctrine shape as the two contradictions above, one level down:
// `design-pass` told agents to call `buildCorrectiveInfographicPrompt`, which had
// no production call site, and `generate-radar-report` once taught the removed
// `createAndSaveReport`. No existing gate catches this — `code-graph-gate.mjs`
// finds orphan MODULES, not dead symbols inside surviving ones, and the
// invariants gate only proves the generated blob matches its skill SOURCE, never
// that the skill source matches the CODE.
//
// knip cannot close this either. Measured on this checkout: knip reports no
// unused exports from `design-tokens.ts` even though `darkExecutive` had zero
// production callers, because `knip.json` lists test files as entry points, so
// a symbol referenced only by a test counts as used.
// ---------------------------------------------------------------------------

const SOURCE_ROOTS = ['src', 'agent/src', 'scripts'];
/**
 * The generated skill blob is a VERBATIM COPY of the skill text, so including it
 * would make every phantom vouch for itself. Excluding it is what makes this
 * check non-circular.
 */
const EXCLUDED_FROM_CORPUS = [join('src', 'lib', 'mcp', 'generated')];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (EXCLUDED_FROM_CORPUS.some((excluded) => full.includes(excluded))) continue;
    if (entry.isDirectory()) {
      // Tests are excluded so the corpus cannot vouch for a symbol that only a
      // test mentions — including THIS file, whose failure-first case names a
      // deleted function as a string literal.
      if (['node_modules', 'dist', '__tests__'].includes(entry.name)) continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Ambient names that resolve without appearing in this repo's source — test
 * runner globals a skill about WRITING TESTS necessarily mentions. This is a
 * resolver-completeness entry, not a suppression: each of these is a real,
 * callable symbol at the point the instruction is followed. A dead platform
 * function could never qualify.
 */
const AMBIENT_GLOBALS = ['beforeEach', 'afterEach', 'beforeAll', 'afterAll'];

/** Every identifier that appears anywhere in real source — declared or used. */
function sourceIdentifiers(): Set<string> {
  const identifiers = new Set<string>(AMBIENT_GLOBALS);
  for (const root of SOURCE_ROOTS) {
    for (const file of collectSourceFiles(join(REPO_ROOT, root))) {
      for (const token of readFileSync(file, 'utf-8').match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? []) {
        identifiers.add(token);
      }
    }
  }
  return identifiers;
}

/**
 * Backticked tokens in instruction prose that are unambiguously CODE symbols:
 * camelCase, so at least one interior capital and a lowercase first character.
 * That shape excludes prose words, kebab-case CSS classes, file paths, HTML tags
 * and `--css-vars`, all of which are written differently.
 */
export function codeSymbolsNamedIn(source: string): string[] {
  const symbols = new Set<string>();
  for (const line of source.split('\n')) {
    if (describesExternalData(line)) continue;
    for (const [, raw] of line.matchAll(/`([^`\n]{1,80})`/g)) {
      const token = raw.trim().replace(/\(\)$/, '');
      if (/^[a-z][A-Za-z0-9]*$/.test(token) && /[A-Z]/.test(token) && token.length >= 4) {
        symbols.add(token);
      }
    }
  }
  return [...symbols];
}

/**
 * True when a line names DATA an agent will encounter rather than a capability
 * it should call — "Fields labeled `canonicalSmiles`" describes a key in someone
 * else's payload, not a platform symbol. Same exemption shape as
 * {@link isProhibitionContext}, and the same reason: an instruction has to be
 * able to write a token down without asserting the platform provides it.
 */
function describesExternalData(line: string): boolean {
  return /\b(field|fields|labell?ed|property|properties|key|keys|attribute|column)\b/i.test(line);
}

describe('served instructions never name a symbol the codebase does not have', () => {
  const documents = servedInstructionDocuments();
  const identifiers = sourceIdentifiers();

  it('built a real corpus, and did not vouch for phantoms via the generated blob', () => {
    expect(identifiers.size).toBeGreaterThan(5000);
    // Sanity: a symbol that genuinely exists resolves...
    expect(identifiers.has('analyzeCreatorBrand')).toBe(true);
    // ...and one deleted in this row does not, even though the skill text that
    // used to name it was copied into the generated manifest.
    expect(identifiers.has('buildCorrectiveInfographicPrompt')).toBe(false);
    expect(identifiers.has('darkExecutive')).toBe(false);
  });

  it.each(documents.map((d) => [d.label, d.source] as const))('%s names only symbols that exist', (label, source) => {
    const phantom = codeSymbolsNamedIn(source).filter((symbol) => !identifiers.has(symbol));
    expect({ [label]: phantom }).toEqual({ [label]: [] });
  });

  it('FAILS when an instruction names a deleted function', () => {
    // Failure-first: the exact regression this check exists for.
    const stale = 'Regenerate it once with `buildCorrectiveInfographicPrompt`.';
    expect(codeSymbolsNamedIn(stale)).toEqual(['buildCorrectiveInfographicPrompt']);
    expect(codeSymbolsNamedIn(stale).filter((s) => !identifiers.has(s))).toEqual(['buildCorrectiveInfographicPrompt']);
  });

  it('does not fire on the non-symbol shapes instructions legitimately use', () => {
    expect(codeSymbolsNamedIn('`--accent-gold` `.report-figure` `report-brand.css` `<img>` `ref-1`')).toEqual([]);
  });

  it('does not fire on a data field an agent will encounter in someone else input', () => {
    // Real case from `smiles-sanity-check`: a key in an external payload, not a
    // capability the platform claims to expose.
    expect(codeSymbolsNamedIn('- Fields labeled `smiles:`, `SMILES:`, or `canonicalSmiles`.')).toEqual([]);
    // ...but the same token in a CALL position is still caught.
    expect(codeSymbolsNamedIn('Call `canonicalSmiles` to normalise the structure.')).toEqual(['canonicalSmiles']);
  });
});

describe('REPORT-013: both authoring paths expose the same full copyable source URL', () => {
  // A real, ordinary source: a news/proxy link carrying the origin as a `?url=`
  // parameter. The composer escapes source URLs as it renders them, so composed
  // reports were fine; the legacy path emits author-written markup, and the
  // gate's external-resource rule matches `url=https://` anywhere in the stored
  // bytes — refusing the WHOLE report over a legitimate citation.
  const SOURCE_URL = 'https://news.example.com/read?url=https://origin.example.com/paper&id=7';
  const legacyDraft = `<li id="ref-1">A. Smith — <span class="ref-source">${SOURCE_URL}</span></li>`;

  it('FAILS publication un-normalized — the defect this fixes', () => {
    const findings = detectExecutableReportContent(legacyDraft);
    expect(findings.map((f) => f.kind)).toContain('external-resource');
  });

  it('publishes once normalized, through the real sanitizer', () => {
    const stored = sanitizeReportHtml(normalizeSourceUrlText(legacyDraft));
    expect(detectExecutableReportContent(stored)).toEqual([]);
  });

  it('keeps the URL byte-for-byte recoverable by a reader who copies it', () => {
    const stored = sanitizeReportHtml(normalizeSourceUrlText(legacyDraft));
    const inner = /<span[^>]*>([\s\S]*?)<\/span>/.exec(stored)?.[1] ?? '';
    expect(decodeBasicHtmlEntities(inner)).toBe(SOURCE_URL);
  });

  it('is idempotent — re-publishing an already-normalized draft does not double-escape', () => {
    const once = normalizeSourceUrlText(legacyDraft);
    expect(normalizeSourceUrlText(once)).toBe(once);
  });

  it('leaves CSS url(https://…) alone, so the gate keeps its full strength', () => {
    // The rule exists to catch off-origin FETCHES. Normalization must not
    // launder one into publishability.
    const hostile = `<style>body { background: url(https://evil.example.com/x.png); }</style>`;
    expect(normalizeSourceUrlText(hostile)).toBe(hostile);
    expect(detectExecutableReportContent(hostile).map((f) => f.kind)).toContain('external-resource');
  });

  it('flattens an off-origin anchor inside a ref-source to plain text', () => {
    const withAnchor = `<span class="ref-source"><a href="https://example.com/p">example.com</a></span>`;
    const normalized = normalizeSourceUrlText(withAnchor);
    expect(normalized).not.toContain('<a ');
    expect(detectExecutableReportContent(normalized)).toEqual([]);
  });
});

describe('the conformance scan actually detects the two historical regressions', () => {
  it('catches a mandated remote infographic embed', () => {
    const instruction = 'Infographics must be embedded as `<img src="https://firebasestorage.googleapis.com/x.png">`.';
    const findings = findContractConformanceViolations(instruction);
    expect(findings.map((f) => f.probeId)).toContain('remote-image-src');
  });

  it('catches a mandated externally linked IEEE reference', () => {
    const instruction =
      '<li id="ref-1"><span class="ref-num">[1]</span> … — <a href="https://example.com">source</a></li>';
    const findings = findContractConformanceViolations(instruction);
    expect(findings.map((f) => f.probeId)).toContain('off-origin-anchor');
  });

  it('does not fire on an instruction that shows a construct in order to forbid it', () => {
    const instruction = 'never remote `<img src="https://host/x.png">` URLs — publication rejects them';
    expect(isProhibitionContext(instruction)).toBe(true);
    expect(findContractConformanceViolations(instruction)).toEqual([]);
  });

  it('does not fire on the compliant forms the instructions now teach', () => {
    const compliant = [
      `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-abc" alt="Adoption curve">`,
      '<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>',
      '<span class="ref-source">https://example.com/full/path</span>',
    ].join('\n');
    expect(findContractConformanceViolations(compliant)).toEqual([]);
  });

  it('agrees with the runtime gate: every compliant form is publishable', () => {
    const compliant = `<!doctype html><html><body>
      <img src="data:image/jpeg;base64,/9j/4AAQ" alt="Embedded figure">
      <a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>
      <ol><li id="ref-1">A. Smith — <span class="ref-source">https://example.com/paper</span></li></ol>
    </body></html>`;
    expect(detectExecutableReportContent(compliant)).toEqual([]);
  });

  it('keeps every probe paired with the rule that rejects it and a compliant alternative', () => {
    for (const probe of PUBLICATION_CONTRACT_PROBES) {
      expect(probe.rejectedBy).not.toHaveLength(0);
      expect(probe.compliantForm).not.toHaveLength(0);
    }
  });
});
