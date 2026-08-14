const ACRONYMS = new Set(['ai', 'ar', 'vr', 'api', 'llm', 'trl', 'iot', 'hr', 'r&d']);

export function formatEnumLabel(value: string, overrides?: Record<string, string>): string {
  if (overrides?.[value]) return overrides[value];
  return value
    .split(/[_\-\s]+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
