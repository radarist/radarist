/**
 * REPORT-006 — the publish-contract constants themselves. The platform-side
 * twin (src/lib/mcp/servers/__tests__/reports-server.test.ts) pins the MCP
 * payload to exactly these field names; together the two tests hold the prompt
 * and the runtime to one contract.
 */
import {
  PUBLISH_RESULT_FIELDS,
  PUBLISH_RESULT_SHAPE,
  PUBLISH_COMPLETION_SIGNAL_RULE,
  PUBLISH_PRIVACY_RULE,
} from '../src/publish-contract';

describe('publish contract constants', () => {
  it('the shape string is derived from the field list (no hand-drift possible)', () => {
    expect(PUBLISH_RESULT_FIELDS).toEqual(['reportId', 'reportUrl', 'isUpsert']);
    for (const field of PUBLISH_RESULT_FIELDS) {
      expect(PUBLISH_RESULT_SHAPE).toContain(field);
    }
    expect(PUBLISH_RESULT_SHAPE).toBe('`{success:true, data:{reportId, reportUrl, isUpsert}}`');
  });

  it('completion rule outputs the private reportUrl and stops the turn', () => {
    expect(PUBLISH_COMPLETION_SIGNAL_RULE).toContain(PUBLISH_RESULT_SHAPE);
    expect(PUBLISH_COMPLETION_SIGNAL_RULE).toContain('data.reportUrl');
    expect(PUBLISH_COMPLETION_SIGNAL_RULE).toContain('/reports/{id}');
    expect(PUBLISH_COMPLETION_SIGNAL_RULE).toContain('THIS TURN IS COMPLETE');
    expect(PUBLISH_COMPLETION_SIGNAL_RULE).toContain('STOP');
  });

  it('privacy rule allows /share only after persisted shared:true and never at publish', () => {
    expect(PUBLISH_PRIVACY_RULE).toContain('shared:false');
    expect(PUBLISH_PRIVACY_RULE).toContain('needs-review');
    expect(PUBLISH_PRIVACY_RULE).toContain('shared:true');
    expect(PUBLISH_PRIVACY_RULE).toContain('NEVER output or invent a /share/report/');
  });

  it('neither rule resurrects the stale shareUrl field', () => {
    expect(PUBLISH_COMPLETION_SIGNAL_RULE).not.toContain('shareUrl');
    expect(PUBLISH_PRIVACY_RULE).not.toContain('shareUrl');
  });
});
