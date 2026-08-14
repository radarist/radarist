import { createHash, timingSafeEqual } from 'node:crypto';

export const SUPER_GRAPH_PROVENANCE_ATTRIBUTE = 'data-radarist-super-graph-sha256';

const ROOT_SVG_RE = /<svg\b[^>]*>/i;
const PROVENANCE_RE = new RegExp(`\\s${SUPER_GRAPH_PROVENANCE_ATTRIBUTE}=(['\"])([a-f0-9]{64})\\1`, 'i');

function withoutRootProvenance(svg: string): { svg: string; digest?: string } {
  const root = ROOT_SVG_RE.exec(svg);
  if (!root) return { svg };

  const marker = PROVENANCE_RE.exec(root[0]);
  if (!marker) return { svg };

  const cleanRoot = root[0].replace(marker[0], '');
  return {
    svg: `${svg.slice(0, root.index)}${cleanRoot}${svg.slice(root.index + root[0].length)}`,
    digest: marker[2].toLowerCase(),
  };
}

function digestSvg(svg: string): string {
  return createHash('sha256').update(svg, 'utf8').digest('hex');
}

/**
 * Marks the exact SVG returned by the platform renderer. The digest is
 * tamper-evident: report quality checks can ignore renderer-owned CSS without
 * granting the same exemption to edited or hand-authored nested SVG styles.
 */
export function markSuperGraphSvg(svg: string): string {
  const clean = withoutRootProvenance(svg).svg;
  const root = ROOT_SVG_RE.exec(clean);
  if (!root) return svg;

  const markedRoot = root[0].replace(/^<svg\b/i, `<svg ${SUPER_GRAPH_PROVENANCE_ATTRIBUTE}="${digestSvg(clean)}"`);
  return `${clean.slice(0, root.index)}${markedRoot}${clean.slice(root.index + root[0].length)}`;
}

/** True only while the marked SVG remains byte-for-byte renderer output. */
export function hasValidSuperGraphProvenance(svg: string): boolean {
  const unmarked = withoutRootProvenance(svg);
  if (!unmarked.digest) return false;

  const expected = Buffer.from(digestSvg(unmarked.svg), 'hex');
  const actual = Buffer.from(unmarked.digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
