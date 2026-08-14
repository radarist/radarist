import { formatEnumLabel } from '../enum-label';

describe('formatEnumLabel', () => {
  it('title-cases snake_case', () => {
    expect(formatEnumLabel('in_progress')).toBe('In Progress');
  });
  it('title-cases kebab-case', () => {
    expect(formatEnumLabel('narrative-synthesizer')).toBe('Narrative Synthesizer');
  });
  it('applies override map first', () => {
    expect(formatEnumLabel('food_agriculture', { food_agriculture: 'Food & Agriculture' })).toBe('Food & Agriculture');
  });
  it('preserves known acronyms', () => {
    expect(formatEnumLabel('ai_assistant')).toBe('AI Assistant');
  });
  it('passes through already-clean values', () => {
    expect(formatEnumLabel('Approved')).toBe('Approved');
  });
});
