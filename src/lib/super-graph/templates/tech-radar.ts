import type { DesignTokens } from '../design-tokens';
import { TechRadarData, type TechRadarPayload } from '../schemas/tech-radar';
import { computeLayout, type PlacedBlip, type OverflowBlip } from './tech-radar-layout';
import { escapeXml } from '../xml';
import { getSliceDividerSegment, getQuadrantLabelPosition } from '@/lib/radar-utils';

const TITLE_BAND = 80;
const LEGEND_HEADER_H = 22;
const LEGEND_ROW_H = 18;
const LEGEND_BOTTOM_PAD = 24;

/** Disc radius scales with item count so density stays constant across radar sizes. */
function computeRadiusForN(nItems: number): number {
  const R_MIN = 360;
  const R_MAX = 620;
  // ~360 + sqrt(n) * 36; for 10 items → 474, 50 items → 614 (clamped to 620).
  return Math.round(Math.min(R_MAX, Math.max(R_MIN, 360 + Math.sqrt(nItems) * 36)));
}

export function renderTechRadar(rawData: unknown, t: DesignTokens): string {
  const data: TechRadarPayload = TechRadarData.parse(rawData);
  const N = data.quadrants.length;
  const fontFamily = escapeXml(t.type.family);

  // Quadrant accent colors derived from the color-blind-safe sequence palette.
  const quadrantColors = (qi: number): string => t.color.sequence[qi % t.color.sequence.length];

  const RADIUS_MAX = computeRadiusForN(data.items.length);
  const VIEWBOX_W = Math.max(1600, RADIUS_MAX * 2 + 680); // 340px gutters L+R for labels
  const DISC_AREA_H = TITLE_BAND + RADIUS_MAX * 2 + 120;
  const CENTER = { x: VIEWBOX_W / 2, y: TITLE_BAND + RADIUS_MAX + 40 };
  const LEGEND_TOP_BASE = DISC_AREA_H + 20;

  // Ring radii — equal bands outward.
  const ringRadii = data.rings.map((_, i) => Math.round(((i + 1) / data.rings.length) * RADIUS_MAX));
  const ringInnerR = (i: number) => (i === 0 ? 0 : ringRadii[i - 1]);

  // Compute ring-label and quadrant-title bboxes up front so the placement engine
  // can avoid them when it places blip labels.
  const fontSize = t.type.scale.small;
  const charWidth = fontSize * 0.62;
  const lineH = fontSize * 1.25;
  const quadrantTitleFont = t.type.scale.lg;
  const quadrantTitleCharW = quadrantTitleFont * 0.62;
  const quadrantTitleH = quadrantTitleFont * 1.25;

  const ringLabelBoxes = data.rings.map((label, i) => {
    const rMid = (ringInnerR(i) + ringRadii[i]) / 2;
    const w = label.length * charWidth + 16;
    return { x: CENTER.x - w / 2, y: CENTER.y - rMid - lineH / 2 - 4, w, h: lineH + 8 };
  });

  // Compute quadrant-title positions (used for both reservedBoxes and rendering).
  const quadrantTitlePositions = data.quadrants.map((q, qi) => {
    const pos = getQuadrantLabelPosition(qi, N, 60); // pushed further out (was 56)
    const left = parseFloat(pos.left);
    const top = parseFloat(pos.top);
    const x = CENTER.x + ((left - 50) / 50) * RADIUS_MAX;
    const y = CENTER.y + ((top - 50) / 50) * RADIUS_MAX;
    const anchor: 'start' | 'middle' | 'end' =
      pos.textAlign === 'left' ? 'start' : pos.textAlign === 'right' ? 'end' : 'middle';
    const w = q.name.length * quadrantTitleCharW + 12;
    const bx = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    const by = y - quadrantTitleH;
    return { qi, q, x, y, anchor, bbox: { x: bx, y: by, w, h: quadrantTitleH + 12 } };
  });

  const reservedBoxes = [...ringLabelBoxes, ...quadrantTitlePositions.map((p) => p.bbox)];

  const layout = computeLayout({
    items: data.items,
    quadrants: data.quadrants,
    rings: data.rings,
    radius: RADIUS_MAX,
    fontSize,
    charWidth,
    pad: 4,
    center: CENTER,
    seedPrefix: 'super-graph-tech-radar',
    reservedBoxes,
  });

  // Compute legend layout (min(N, 4) columns; rows wrap if N > 4).
  const legendCols = Math.min(N, 4);
  const legendRowsOfQuadrants = Math.ceil(N / legendCols);
  const groupsByQuadrant: OverflowBlip[][] = data.quadrants.map((q) =>
    layout.overflow.filter((o) => o.item.quadrantId === q.id)
  );
  const tallestColumn = Math.max(0, ...groupsByQuadrant.map((g) => g.length));
  const legendBlockH =
    layout.overflow.length === 0 ? 0 : LEGEND_HEADER_H + tallestColumn * LEGEND_ROW_H + LEGEND_BOTTOM_PAD;
  const totalLegendH = legendBlockH * legendRowsOfQuadrants;
  const VIEWBOX_H = layout.overflow.length === 0 ? DISC_AREA_H : LEGEND_TOP_BASE + totalLegendH;

  const dotStroke = t.mode === 'dark' ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.35)';
  const leaderColor = t.color.leader;
  // Halo: ring around dot for separation against ring bands. Mode-aware.
  const dotHalo = t.mode === 'dark' ? 'rgba(6,24,47,0.85)' : 'rgba(255,255,255,0.95)';

  // ── Background ─────────────────────────────────────────────────
  const bg = `<rect width="${VIEWBOX_W}" height="${VIEWBOX_H}" fill="${t.color.canvas}"/>`;

  // ── Ring bands — progressive ink-alpha for topographic depth ────
  // No quadrant tints (would create 4-spike pinwheel artifact). Quadrant identity
  // comes from blip color + quadrant titles outside the disc.
  const ringBands = data.rings.map((_, i) => {
    const rOuter = ringRadii[i];
    const rInner = ringInnerR(i);
    const rMid = (rOuter + rInner) / 2;
    const w = rOuter - rInner;
    const alpha = 0.015 + i * 0.022; // 0.015 → ~0.08 across 4 rings (lighter than v1)
    return `<circle cx="${CENTER.x}" cy="${CENTER.y}" r="${rMid.toFixed(1)}" fill="none" stroke="${t.color.ink}" stroke-opacity="${alpha.toFixed(3)}" stroke-width="${w.toFixed(1)}"/>`;
  });

  // ── Concentric ring strokes ────────────────────────────────────
  const ringCircles = ringRadii.map(
    (r) =>
      `<circle cx="${CENTER.x}" cy="${CENTER.y}" r="${r}" fill="none" stroke="${t.color.rule}" stroke-width="${t.geom.strokeBase}"/>`
  );

  // ── Slice dividers (N rays from center). None when N=1. ────────
  const dividers: string[] = [];
  if (N >= 2) {
    for (let i = 0; i < N; i++) {
      const seg = getSliceDividerSegment(i, N);
      if (!seg) continue;
      const x2 = CENTER.x + ((seg.x2 - 50) / 50) * RADIUS_MAX;
      const y2 = CENTER.y + ((seg.y2 - 50) / 50) * RADIUS_MAX;
      dividers.push(
        `<line x1="${CENTER.x}" y1="${CENTER.y}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${t.color.rule}" stroke-width="${t.geom.strokeFine}" stroke-dasharray="4 4"/>`
      );
    }
  }

  // ── Ring labels along the top axis (12 o'clock). Reduced opacity so they recede. ─
  const ringLabels = data.rings.map((label, i) => {
    const rMid = (ringInnerR(i) + ringRadii[i]) / 2;
    return `<text x="${CENTER.x}" y="${CENTER.y - rMid}" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-size="${t.type.scale.small}" font-weight="${t.type.weightMedium}" letter-spacing="0.12em" fill="${t.color.muted}" fill-opacity="0.55">${escapeXml(label)}</text>`;
  });

  // ── Quadrant titles (outside the disc). Tighter tracking, weight 600. ────────
  const quadrantTitles = quadrantTitlePositions.map(({ qi, q, x, y, anchor }) => {
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-family="${fontFamily}" font-size="${t.type.scale.lg}" font-weight="${t.type.weightMedium}" letter-spacing="0.04em" fill="${quadrantColors(qi)}">${escapeXml(q.name)}</text>`;
  });

  // ── Inline blips ──────────────────────────────────────────────
  const dotR = 5.5;
  const orderById = new Map(data.quadrants.map((q, i) => [q.id, i]));
  const inlineBlips = layout.placed.map((p: PlacedBlip) => {
    const qi = orderById.get(p.item.quadrantId) ?? 0;
    const labelX =
      p.labelAnchor === 'end'
        ? p.labelBox.x + p.labelBox.w
        : p.labelAnchor === 'middle'
          ? p.labelBox.x + p.labelBox.w / 2
          : p.labelBox.x;
    const labelY = p.labelBox.y + p.labelBox.h - 4;
    const leader = p.leader
      ? `<line x1="${p.dot.x.toFixed(1)}" y1="${p.dot.y.toFixed(1)}" x2="${labelX.toFixed(1)}" y2="${labelY.toFixed(1)}" stroke="${leaderColor}" stroke-width="1" stroke-opacity="0.55" stroke-linecap="round" data-role="blip-leader"/>`
      : '';
    return `<g>
      ${leader}
      <circle cx="${p.dot.x.toFixed(1)}" cy="${p.dot.y.toFixed(1)}" r="${dotR + 1.5}" fill="${dotHalo}" data-role="blip-halo"/>
      <circle cx="${p.dot.x.toFixed(1)}" cy="${p.dot.y.toFixed(1)}" r="${dotR}" fill="${quadrantColors(qi)}" stroke="${dotStroke}" stroke-width="${t.geom.strokeBase}" data-role="blip-dot"/>
      <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${p.labelAnchor}" font-family="${fontFamily}" font-size="${t.type.scale.small}" fill="${t.color.ink}" data-role="blip-label">${escapeXml(p.item.name)}</text>
    </g>`;
  });

  // ── Overflow blips ────────────────────────────────────────────
  const overflowDots = layout.overflow.map((o: OverflowBlip) => {
    const qi = orderById.get(o.item.quadrantId) ?? 0;
    return `<g>
      <circle cx="${o.dot.x.toFixed(1)}" cy="${o.dot.y.toFixed(1)}" r="${dotR + 1.5}" fill="${dotHalo}" data-role="blip-halo"/>
      <circle cx="${o.dot.x.toFixed(1)}" cy="${o.dot.y.toFixed(1)}" r="${dotR}" fill="${quadrantColors(qi)}" stroke="${dotStroke}" stroke-width="${t.geom.strokeBase}" data-role="blip-dot"/>
      <text x="${o.inlineNumberPos.x.toFixed(1)}" y="${o.inlineNumberPos.y.toFixed(1)}" font-family="${fontFamily}" font-size="${t.type.scale.caption}" font-weight="${t.type.weightBold}" fill="${quadrantColors(qi)}" data-role="blip-number">${o.legendNumber}</text>
    </g>`;
  });

  // ── Legend grid: min(N, 4) columns; rows wrap when N > 4. ─────
  let legendSvg = '';
  if (layout.overflow.length > 0) {
    const colWidth = VIEWBOX_W / legendCols;
    legendSvg = data.quadrants
      .map((q, qi) => {
        const items = groupsByQuadrant[qi];
        if (items.length === 0) return '';
        const colIdx = qi % legendCols;
        const rowIdx = Math.floor(qi / legendCols);
        const colX = (colIdx + 0.5) * colWidth;
        const headerY = LEGEND_TOP_BASE + rowIdx * legendBlockH + 14;
        const rows = items
          .map(
            (o, ri) =>
              `<text x="${colX}" y="${(headerY + LEGEND_HEADER_H + ri * LEGEND_ROW_H).toFixed(1)}" text-anchor="middle" font-family="${fontFamily}" font-size="${t.type.scale.caption}" fill="${t.color.ink}" data-role="legend-row">${o.legendNumber}. ${escapeXml(o.name)}</text>`
          )
          .join('');
        return `<g><text x="${colX}" y="${headerY}" text-anchor="middle" font-family="${fontFamily}" font-size="${t.type.scale.small}" font-weight="${t.type.weightBold}" letter-spacing="0.06em" fill="${quadrantColors(qi)}">${escapeXml(q.name.toUpperCase())}</text>${rows}</g>`;
      })
      .join('');
  }

  // ── Title band ────────────────────────────────────────────────
  const titleEl = data.title
    ? `<text x="${CENTER.x}" y="${TITLE_BAND - 28}" text-anchor="middle" dominant-baseline="hanging" font-family="${fontFamily}" font-size="${t.type.scale.title}" font-weight="${t.type.weightBold}" fill="${t.color.ink}">${escapeXml(data.title)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_W} ${VIEWBOX_H}" preserveAspectRatio="xMidYMid meet">
  ${bg}
  ${titleEl}
  ${ringBands.join('\n  ')}
  ${ringCircles.join('\n  ')}
  ${dividers.join('\n  ')}
  ${ringLabels.join('\n  ')}
  ${quadrantTitles.join('\n  ')}
  ${inlineBlips.join('\n  ')}
  ${overflowDots.join('\n  ')}
  ${legendSvg}
</svg>`;
}
