/** Shared, bounded parser for IEEE-style numeric source markers. */
const GROUP_RE = /\[\s*\d+(?:\s*[,‐-―-]\s*\d+)*\s*\]/g;
const RANGE_RE = /(\d+)\s*[‐-―-]\s*(\d+)/g;
const NUMBER_RE = /\d+/g;
const MAX_RANGE_SPAN = 24;

export function citationSourceIds(text: string): number[] {
  const ids = new Set<number>();
  const add = (value: number): void => {
    if (Number.isFinite(value) && value > 0) ids.add(value);
  };
  GROUP_RE.lastIndex = 0;
  let marker: RegExpExecArray | null;
  while ((marker = GROUP_RE.exec(text)) !== null) {
    const inner = marker[0].slice(1, -1);
    const consumed: string[] = [];
    RANGE_RE.lastIndex = 0;
    let range: RegExpExecArray | null;
    while ((range = RANGE_RE.exec(inner)) !== null) {
      const from = Number.parseInt(range[1]!, 10);
      const to = Number.parseInt(range[2]!, 10);
      consumed.push(range[0]);
      add(from);
      add(to);
      if (to > from && to - from <= MAX_RANGE_SPAN) {
        for (let id = from + 1; id < to; id += 1) add(id);
      }
    }
    const remainder = consumed.reduce((value, span) => value.split(span).join(' '), inner);
    for (const value of remainder.match(NUMBER_RE) ?? []) add(Number.parseInt(value, 10));
  }
  return [...ids].sort((a, b) => a - b);
}
