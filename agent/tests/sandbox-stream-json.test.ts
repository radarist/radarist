/** Parser contracts shared by the private captured and public synthetic fixture. */
import * as fs from 'fs';
import * as path from 'path';
import { extractResult, parseChunk, parseLine } from '../src/sandbox/stream-json.js';

const fixture = fs.readFileSync(path.resolve('tests/fixtures/stream-json/session-1.jsonl'), 'utf8');

describe('stream-json parser', () => {
  it('extracts an authoritative result from the selected fixture', () => {
    const result = extractResult(fixture);
    expect(result).not.toBeNull();
    expect(result!.subtype).toBe('success');
    expect(result!.numTurns).toBeGreaterThan(0);
    expect(result!.totalCostUsd).toBeGreaterThan(0);
  });

  it('parses the whole fixture without throwing and finds tool use + text', () => {
    const { events, rest } = parseChunk(fixture);
    expect(rest).toBe('');
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('assistant-text')).toBe(true);
    expect(kinds.has('tool-use')).toBe(true);
    expect(kinds.has('result')).toBe(true);
  });

  it('holds back a partial trailing line and resumes cleanly', () => {
    const lines = fixture.trim().split('\n');
    const whole = lines[0] + '\n';
    const splitPoint = Math.floor(lines[1].length / 2);
    const first = parseChunk(whole + lines[1].slice(0, splitPoint));
    expect(first.rest).toBe(lines[1].slice(0, splitPoint));
    const second = parseChunk(first.rest + lines[1].slice(splitPoint) + '\n');
    expect(second.rest).toBe('');
    expect(second.events.length + first.events.length).toBeGreaterThan(0);
  });

  it('tolerates malformed lines and unknown event types', () => {
    expect(parseLine('not json at all')).toBeNull();
    expect(parseLine('')).toBeNull();
    expect(parseLine('{"no":"type"}')).toBeNull();
    expect(parseLine('{"type":"brand_new_event_kind"}')).toEqual({ kind: 'other', type: 'brand_new_event_kind' });
  });

  it('extractResult returns null when no result line exists (killed session)', () => {
    const withoutResult = fixture.trim().split('\n').slice(0, -1).join('\n');
    expect(extractResult(withoutResult)).toBeNull();
  });

  it.each([
    ['missing', ''],
    ['string', ',"total_cost_usd":"0.42"'],
    ['negative', ',"total_cost_usd":-0.42'],
  ])('rejects a result whose authoritative cost is %s', (_label, costField) => {
    const invalid = `{"type":"result","subtype":"success","num_turns":1${costField}}`;
    expect(parseLine(invalid)).toEqual({ kind: 'other', type: 'result' });
    expect(extractResult(invalid)).toBeNull();
  });

  it('captures is_error / api_error_status / result text on a failed result', () => {
    // Some protocol failures retain subtype `success`; error authority therefore
    // comes from is_error rather than subtype.
    const errored =
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":404,' +
      '"num_turns":1,"total_cost_usd":0,' +
      '"result":"The selected model (unavailable-model) is unavailable."}';
    const result = extractResult(errored);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.apiErrorStatus).toBe(404);
    expect(result!.resultText).toContain('unavailable-model');
    expect(result!.totalCostUsd).toBe(0);
  });

  it('does not flag a clean result as an error', () => {
    const result = extractResult(fixture);
    expect(result!.isError).not.toBe(true);
    expect(result!.apiErrorStatus).toBeUndefined();
  });
});
