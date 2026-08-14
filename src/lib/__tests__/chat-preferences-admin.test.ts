/**
 * @jest-environment node
 *
 * AI-007 — chatPreferences/{uid} admin module: explicit chat working-style
 * notes (consent-by-construction — only the saveWorkingStylePreference tool
 * writes here). Covers CRUD, the 10-note cap with oldest-eviction, per-note
 * length limits, and the bounded injectable block.
 */
export {};

const store = new Map<string, Record<string, unknown>>();
const db = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({ exists: store.has(`${name}/${id}`), data: () => store.get(`${name}/${id}`) }),
      set: async (d: Record<string, unknown>) => void store.set(`${name}/${id}`, d),
      delete: async () => void store.delete(`${name}/${id}`),
    }),
  }),
};
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const {
  getChatPreferences,
  addStyleNote,
  clearStyleNotes,
  buildWorkingStyleBlock,
  MAX_STYLE_NOTES,
  MAX_NOTE_LENGTH,
  WORKING_STYLE_BLOCK_MAX_CHARS,
} = require('../chat-preferences-admin') as typeof import('../chat-preferences-admin');

beforeEach(() => store.clear());

describe('getChatPreferences', () => {
  it('returns null when nothing is stored', async () => {
    expect(await getChatPreferences('u1')).toBeNull();
  });

  it('treats a corrupt stored doc as empty instead of throwing', async () => {
    store.set('chatPreferences/u1', { styleNotes: 'not-an-array' });
    expect(await getChatPreferences('u1')).toBeNull();
  });
});

describe('addStyleNote', () => {
  it('appends a trimmed note with id + createdAt', async () => {
    const { note, total, evicted } = await addStyleNote('u1', '  Keep answers short.  ');
    expect(note.note).toBe('Keep answers short.');
    expect(note.id).toBeTruthy();
    expect(total).toBe(1);
    expect(evicted).toBe(0);

    const prefs = await getChatPreferences('u1');
    expect(prefs!.userId).toBe('u1');
    expect(prefs!.styleNotes).toHaveLength(1);
  });

  it('rejects empty and over-long notes with clear errors', async () => {
    await expect(addStyleNote('u1', '   ')).rejects.toThrow(/cannot be empty/i);
    await expect(addStyleNote('u1', 'x'.repeat(MAX_NOTE_LENGTH + 1))).rejects.toThrow(/at most/i);
    expect(await getChatPreferences('u1')).toBeNull(); // nothing persisted
  });

  it(`caps at ${MAX_STYLE_NOTES} notes, evicting the OLDEST (newest wins)`, async () => {
    for (let i = 1; i <= MAX_STYLE_NOTES; i++) {
      await addStyleNote('u1', `note ${i}`);
    }
    const { total, evicted } = await addStyleNote('u1', 'note 11');
    expect(total).toBe(MAX_STYLE_NOTES);
    expect(evicted).toBe(1);
    const prefs = await getChatPreferences('u1');
    const texts = prefs!.styleNotes.map((n) => n.note);
    expect(texts).not.toContain('note 1'); // oldest evicted
    expect(texts).toContain('note 11'); // newest kept
    expect(texts).toHaveLength(MAX_STYLE_NOTES);
  });
});

describe('clearStyleNotes', () => {
  it('deletes all notes and reports how many were cleared', async () => {
    await addStyleNote('u1', 'a');
    await addStyleNote('u1', 'b');
    expect(await clearStyleNotes('u1')).toEqual({ cleared: 2 });
    expect(await getChatPreferences('u1')).toBeNull();
  });

  it('is a no-op with cleared:0 when nothing is stored', async () => {
    expect(await clearStyleNotes('u1')).toEqual({ cleared: 0 });
  });
});

describe('buildWorkingStyleBlock', () => {
  it('returns the empty string when no notes exist (callers skip injection)', async () => {
    expect(await buildWorkingStyleBlock('u1')).toBe('');
  });

  it('renders the consent-labeled header plus one bullet per note', async () => {
    await addStyleNote('u1', 'Keep answers short.');
    await addStyleNote('u1', 'Always show sources.');
    const block = await buildWorkingStyleBlock('u1');
    expect(block).toContain('User working-style notes (explicitly saved by the user):');
    expect(block).toContain('- Keep answers short.');
    expect(block).toContain('- Always show sources.');
  });

  it('the injection budget covers the FULL note cap — no stored note is ever silently inactive', async () => {
    // Adversarial #3: a 400-char block vs a 2,400-char store meant notes could
    // be saved yet never injected. The budget now covers the worst case by
    // construction; the arithmetic pin below keeps a future cap change from
    // silently reintroducing the gap.
    for (let i = 1; i <= MAX_STYLE_NOTES; i++) {
      await addStyleNote('u1', `note ${String(i).padStart(2, '0')} ${'y'.repeat(230)}`.slice(0, 240));
    }
    const block = await buildWorkingStyleBlock('u1');
    expect(block.length).toBeLessThanOrEqual(WORKING_STYLE_BLOCK_MAX_CHARS);
    for (let i = 1; i <= MAX_STYLE_NOTES; i++) {
      expect(block).toContain(`note ${String(i).padStart(2, '0')}`); // EVERY stored note injected
    }
    // worst case: cap × (max note + '- ' + newline) + header must fit
    expect(MAX_STYLE_NOTES * (240 + 3) + 60).toBeLessThanOrEqual(WORKING_STYLE_BLOCK_MAX_CHARS);
  });
});
