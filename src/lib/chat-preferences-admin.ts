/**
 * @file lib/chat-preferences-admin.ts
 * @description AI-007 — explicit chat working-style memory (admin SDK, server-only).
 *
 * Firestore store `chatPreferences/{uid}`: a small doc of short working-style
 * notes the USER explicitly asked the assistant to remember ("answer tersely",
 * "always show sources", …). DELIBERATELY separate from `userPreferences/{uid}`
 * (the mission/report-shaped nightly harvest): these are chat-shaped,
 * consent-by-construction — written ONLY via the saveWorkingStylePreference
 * tool when the user explicitly asks, never inferred.
 *
 * Injection: the chat route reads buildWorkingStyleBlock() into the VOLATILE
 * session-context block of the user turn (never the byte-stable system
 * prompt), bounded to WORKING_STYLE_BLOCK_MAX_CHARS.
 */

import 'server-only';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from './firebase-admin';
import { createLogger } from './logger';

const log = createLogger('chat-preferences-admin');

const COLLECTION = 'chatPreferences';

/** Hard cap on stored notes — oldest evicted beyond this. */
export const MAX_STYLE_NOTES = 10;
/** Per-note length cap (chars) — keeps the injected block meaningful. */
export const MAX_NOTE_LENGTH = 240;
/** Bound on the injected chat-context block (chars). */
export const WORKING_STYLE_BLOCK_MAX_CHARS = 2600;

export const styleNoteSchema = z.object({
  id: z.string().min(1),
  note: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
  createdAt: z.string(),
});
export type StyleNote = z.infer<typeof styleNoteSchema>;

export const chatPreferencesSchema = z.object({
  userId: z.string().min(1),
  styleNotes: z.array(styleNoteSchema).max(MAX_STYLE_NOTES),
  updatedAt: z.string(),
});
export type ChatPreferences = z.infer<typeof chatPreferencesSchema>;

/**
 * Read the user's chat preferences. Returns null when nothing has been saved
 * (or the stored doc no longer parses — treated as empty, never a throw).
 */
export async function getChatPreferences(userId: string): Promise<ChatPreferences | null> {
  const doc = await db.collection(COLLECTION).doc(userId).get();
  if (!doc.exists) return null;
  const parsed = chatPreferencesSchema.safeParse(doc.data());
  if (!parsed.success) {
    log.warn('Stored chatPreferences doc failed validation — treating as empty', { userId });
    return null;
  }
  return parsed.data;
}

/**
 * Append an explicitly-saved working-style note. Notes beyond MAX_STYLE_NOTES
 * evict the OLDEST (newest wins — the user just said it). Throws on an
 * empty/over-long note; callers surface the message as a tool error.
 */
export async function addStyleNote(
  userId: string,
  note: string
): Promise<{ note: StyleNote; total: number; evicted: number }> {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new Error('A working-style note cannot be empty.');
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new Error(`A working-style note must be at most ${MAX_NOTE_LENGTH} characters.`);
  }

  const existing = await getChatPreferences(userId);
  const newNote: StyleNote = { id: randomUUID(), note: trimmed, createdAt: new Date().toISOString() };
  const combined = [...(existing?.styleNotes ?? []), newNote];
  const evicted = Math.max(0, combined.length - MAX_STYLE_NOTES);
  const styleNotes = combined.slice(evicted); // drop oldest beyond the cap

  const next = chatPreferencesSchema.parse({ userId, styleNotes, updatedAt: new Date().toISOString() });
  await db.collection(COLLECTION).doc(userId).set(next);
  log.info('Working-style note saved', { userId, total: styleNotes.length, evicted });
  return { note: newNote, total: styleNotes.length, evicted };
}

/** Delete every stored working-style note for the user. */
export async function clearStyleNotes(userId: string): Promise<{ cleared: number }> {
  const existing = await getChatPreferences(userId);
  const cleared = existing?.styleNotes.length ?? 0;
  await db.collection(COLLECTION).doc(userId).delete();
  log.info('Working-style notes cleared', { userId, cleared });
  return { cleared };
}

/**
 * Render the injectable chat-context block: a headered, bounded list of the
 * user's explicitly-saved notes. Empty string when there are none — callers
 * skip injection entirely. Newest notes win the budget (they are the most
 * recent explicit asks); the block never exceeds WORKING_STYLE_BLOCK_MAX_CHARS.
 */
export async function buildWorkingStyleBlock(userId: string): Promise<string> {
  const prefs = await getChatPreferences(userId);
  if (!prefs || prefs.styleNotes.length === 0) return '';

  const header = 'User working-style notes (explicitly saved by the user):';
  const lines: string[] = [];
  let length = header.length;
  // Newest-first for budgeting, then restore chronological order for display.
  for (const styleNote of [...prefs.styleNotes].reverse()) {
    const line = `- ${styleNote.note}`;
    if (length + 1 + line.length > WORKING_STYLE_BLOCK_MAX_CHARS) break;
    lines.push(line);
    length += 1 + line.length;
  }
  if (lines.length === 0) return '';
  lines.reverse();
  return [header, ...lines].join('\n');
}
