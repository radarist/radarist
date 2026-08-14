/**
 * @file lib/mission-presets.ts
 * @description Registry of one-click mission presets surfaced as slash commands.
 * A preset encodes a canned, structured mission brief so a user can dispatch a
 * research→artifact mission by typing `/<slashName> <topic>` — with zero brief
 * authoring. Selecting the command seeds the chat input with `seed` (a full
 * static brief ending with a `SUBJECT: ` slot the user completes); the assistant
 * then dispatches it via `startMission` (which mandates its usual confirmation).
 *
 * PURE / CLIENT-SAFE: strings + metadata only. Imported by the client-side slash
 * menu (`slash-commands.ts`) — it MUST NOT import server-only modules.
 *
 * Extending: add a `MissionPreset` entry. The `read-patent-landscape`,
 * `assess-research-momentum` (papers), and `oss-project-health` (OSS) reader
 * skills already exist, so those sources are registry-entry-only; Hacker News /
 * SEC would need a reader skill authored first.
 */

export interface MissionPreset {
  /** Stable id — also the slash name (`/patent-landscape`). */
  id: string;
  /** Display label in the slash menu, e.g. `/patent-landscape`. */
  label: string;
  /** One-line description shown in the slash menu. */
  description: string;
  /** The mission profile the brief dispatches to. */
  agent: 'creator';
  /** The keyless research tool the brief pins (must be a real tool name). */
  sourceTool: string;
  /** The reader skill the brief applies (must exist in the product runtime plugin). */
  readerSkill: string;
  /** The artifact kind produced. */
  outputKind: 'document';
  /**
   * Static seed inserted into the chat input on select — the full structured
   * brief, ending with a `SUBJECT: ` line the user completes with the topic.
   * No runtime rendering (mirrors the `/research` builtin, which the user
   * appends to). MUST reference `sourceTool`, `readerSkill`, and the
   * "Document, not Report" directive so a downstream test can assert them.
   */
  seed: string;
}

const PATENT_LANDSCAPE_SEED = `Run a **creator mission** to build a patent-landscape Document. Dispatch it with startMission (agent: "creator"), passing the brief below as the mission prompt with SUBJECT filled in:

AUDIENCE: a technology strategist scanning the IP landscape.
DECISION CONTEXT: gauge how crowded/contested a technology area is before investing.
DIRECTIVE: call the searchPatents tool (Google Patents) for the SUBJECT, then apply the read-patent-landscape skill to cluster assignees, read the filing timeline (recent vs legacy), and surface whitespace. Write the findings as a Document via the draftDocument tool (markdown → /library/documents), titled "Patent Landscape: <SUBJECT>". Do NOT call publishReport — the deliverable is a library Document, not an HTML report.
CRITICAL DIMENSIONS: total filing volume (crowding signal), top assignees, recent-vs-legacy filing trend, notable whitespace, and the honest CPC/IPC gap (the search endpoint carries no classification codes — do not invent them).
ABSTENTION: if searchPatents degrades (e.g. a 503 rate-limit), say so in the document and do not fabricate filings.

SUBJECT: `;

export const MISSION_PRESETS: readonly MissionPreset[] = [
  {
    id: 'patent-landscape',
    label: '/patent-landscape',
    description: 'Research a topic and save its patent landscape as a Document (creator mission)',
    agent: 'creator',
    sourceTool: 'searchPatents',
    readerSkill: 'read-patent-landscape',
    outputKind: 'document',
    seed: PATENT_LANDSCAPE_SEED,
  },
];

/** Look up a preset by its id / slash name. */
export function getMissionPreset(id: string): MissionPreset | undefined {
  return MISSION_PRESETS.find((p) => p.id === id);
}
