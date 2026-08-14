/**
 * REPORT-006 — the ONE source of truth for what publishReport actually returns
 * and what the Creator/orchestrator prompts may promise about it.
 *
 * The runtime contract (platform side):
 *   - `executePublishReport` → `UpsertReportBySlotResult` (`src/lib/reports.ts`)
 *     serialized by the impulse-reports MCP server as
 *     `{success:true, data:{reportId, reportUrl, isUpsert}}`.
 *   - `data.reportUrl` is the AUTHENTICATED PRIVATE route `/reports/{id}` —
 *     a fresh publish is born `shared:false`, and a needs-review draft stays
 *     private too. There is NO `shareUrl` in the publish result.
 *   - a public `/share/report/{id}` link exists ONLY after the owner later
 *     shares the report (persisted `shared:true`) — surfaced by
 *     listReports/getReportById/updateReport, never by publishReport.
 *
 * Every mission prompt (initial orchestrator preamble AND the subagent
 * mission-context block, which the revision turn re-composes through the same
 * builders) must consume these constants instead of hand-writing the shape, so
 * the prompt can never drift from the runtime again. The historical drift —
 * prompts promising `{reportId, shareUrl}` — taught agents to output public
 * links that rendered "Report Not Shared".
 */

/** Field names of publishReport's real success payload. Pinned by tests on both packages. */
export const PUBLISH_RESULT_FIELDS = ['reportId', 'reportUrl', 'isUpsert'] as const;

/** The result shape exactly as the agent sees it in the tool result. */
export const PUBLISH_RESULT_SHAPE = `\`{success:true, data:{${PUBLISH_RESULT_FIELDS.join(', ')}}}\``;

/**
 * Completion signal — preserves the stop-after-publish behavior verbatim in
 * intent: the publish result ends the turn, no further tool calls.
 */
export const PUBLISH_COMPLETION_SIGNAL_RULE =
  `- COMPLETION SIGNAL: when publishReport returns ${PUBLISH_RESULT_SHAPE}, the report is live in Firestore. ` +
  'THIS TURN IS COMPLETE. Output data.reportUrl — the authenticated private /reports/{id} link — in your final message and STOP. Do not call ANY more tools.';

/**
 * MISSION-011 — the rules a mission gets when its slot manifest requests NO
 * artifact.
 *
 * A Linker can otherwise receive the standard report preamble even when its
 * manifest grants no slot, making every possible `publishReport` call invalid
 * and encouraging a report-tool discovery loop instead of proposal delivery.
 *
 * Saying nothing about reports is not enough: the report tools remain visible on
 * the impulse-reports server, so the absence of an instruction reads as "figure
 * it out". These rules state the negative explicitly, which is what stops the
 * search.
 */
export const NO_ARTIFACT_DELIVERABLE_RULES: readonly string[] = [
  '- THIS MISSION HAS NO ARTIFACT DELIVERABLE. Its slot manifest is empty, so publishReport will REJECT every possible slotName. Your deliverable is the structured output in your FINAL MESSAGE — nothing is published.',
  '- Do NOT call draftReport, publishReport, generateInfographic, generateVisualization, generate_image or renderDiagram at all in this mission. They are not part of your deliverable and cannot succeed. Do not search for them, and do not retry them.',
  '- Do NOT dispatch the creator agent (or any agent) to write, publish or polish a report, document, infographic or deck. There is no artifact to produce; delegating one wastes the whole budget on work that cannot be persisted.',
  '- Follow the REQUIRED DELIVERABLE section of your task prompt exactly. Emit it in your final message and STOP.',
];

/** Privacy rule: never invent a public share link out of a publish result. */
export const PUBLISH_PRIVACY_RULE =
  '- publishReport NEVER returns a public share link. A freshly published report is PRIVATE (shared:false), and a needs-review draft stays private too — its link is still the authenticated /reports/{id} reportUrl. ' +
  'A /share/report/{id} URL is valid ONLY after the owner explicitly shares the report later (persisted shared:true). NEVER output or invent a /share/report/... URL.';
