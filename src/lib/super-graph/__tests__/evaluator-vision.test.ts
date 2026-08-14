import {
  VisionRubricSchema,
  averageRubricScore,
  verdictFromAverage,
  stripCodeFence,
  isVisionCriticEnabled,
  runVisionCritic,
  type VisionRubric,
} from '../evaluator-vision';
import type { DesignTokens } from '../design-tokens';
import type { DiagramRenderer } from '../render';

// Mock Google Generative AI SDK so we can drive the vision call.
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({
      generateContent: (...args: unknown[]) => mockGenerateContent(...args),
    })),
  })),
}));

// Silence logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const buildRubric = (
  overrides: Partial<VisionRubric['scores']> = {},
  issues: VisionRubric['issues'] = []
): VisionRubric => ({
  scores: {
    legibility: 8,
    hierarchy: 8,
    whitespace: 8,
    professionalism: 8,
    label_clarity: 8,
    premium_feel: 8,
    ...overrides,
  },
  issues,
});

const dummyTokens = {} as DesignTokens;
const dummyRenderer = {
  rasterizeSvg: jest.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])), // PNG magic bytes
} as unknown as DiagramRenderer;

const ORIGINAL_ENV = process.env.PER_DIAGRAM_VISION_EVAL;
const ORIGINAL_API_KEY = process.env.GOOGLE_GENAI_API_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PER_DIAGRAM_VISION_EVAL = '1';
  process.env.GOOGLE_GENAI_API_KEY = 'test-key';
  (dummyRenderer.rasterizeSvg as jest.Mock).mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(() => {
  process.env.PER_DIAGRAM_VISION_EVAL = ORIGINAL_ENV;
  process.env.GOOGLE_GENAI_API_KEY = ORIGINAL_API_KEY;
});

describe('VisionRubricSchema', () => {
  it('accepts a well-formed rubric', () => {
    const r = buildRubric();
    expect(() => VisionRubricSchema.parse(r)).not.toThrow();
  });

  it('rejects scores outside 1-10', () => {
    expect(() => VisionRubricSchema.parse(buildRubric({ legibility: 0 }))).toThrow();
    expect(() => VisionRubricSchema.parse(buildRubric({ legibility: 11 }))).toThrow();
  });

  it('rejects missing score dimension', () => {
    const r = buildRubric() as unknown as Record<string, unknown>;
    delete (r.scores as Record<string, unknown>).legibility;
    expect(() => VisionRubricSchema.parse(r)).toThrow();
  });

  it('rejects an issue without a fix', () => {
    expect(() =>
      VisionRubricSchema.parse({
        ...buildRubric(),
        issues: [{ severity: 'low', dimension: 'whitespace' }] as unknown as VisionRubric['issues'],
      })
    ).toThrow();
  });

  it('rejects an unknown severity', () => {
    expect(() =>
      VisionRubricSchema.parse({
        ...buildRubric(),
        issues: [
          { severity: 'critical', dimension: 'whitespace', fix: 'reduce padding' },
        ] as unknown as VisionRubric['issues'],
      })
    ).toThrow();
  });

  it('accepts an empty issues array', () => {
    expect(() => VisionRubricSchema.parse(buildRubric({}, []))).not.toThrow();
  });
});

describe('averageRubricScore', () => {
  it('averages all six dimensions', () => {
    expect(averageRubricScore(buildRubric())).toBe(8);
  });

  it('handles mixed scores', () => {
    const r = buildRubric({
      legibility: 10,
      hierarchy: 9,
      whitespace: 8,
      professionalism: 7,
      label_clarity: 6,
      premium_feel: 5,
    });
    expect(averageRubricScore(r)).toBeCloseTo(7.5, 5);
  });

  it('returns the floor when all scores are 1', () => {
    expect(
      averageRubricScore(
        buildRubric({
          legibility: 1,
          hierarchy: 1,
          whitespace: 1,
          professionalism: 1,
          label_clarity: 1,
          premium_feel: 1,
        })
      )
    ).toBe(1);
  });

  it('returns the ceiling when all scores are 10', () => {
    expect(
      averageRubricScore(
        buildRubric({
          legibility: 10,
          hierarchy: 10,
          whitespace: 10,
          professionalism: 10,
          label_clarity: 10,
          premium_feel: 10,
        })
      )
    ).toBe(10);
  });
});

describe('verdictFromAverage', () => {
  it('PASS at exactly 7.5', () => {
    expect(verdictFromAverage(7.5)).toBe('PASS');
  });

  it('PASS above threshold', () => {
    expect(verdictFromAverage(7.51)).toBe('PASS');
    expect(verdictFromAverage(10)).toBe('PASS');
  });

  it('REVISE below threshold', () => {
    expect(verdictFromAverage(7.49)).toBe('REVISE');
    expect(verdictFromAverage(5)).toBe('REVISE');
    expect(verdictFromAverage(1)).toBe('REVISE');
  });
});

describe('stripCodeFence', () => {
  it('strips a ```json``` fence', () => {
    expect(stripCodeFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('strips a plain ``` fence', () => {
    expect(stripCodeFence('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('leaves an unfenced response alone', () => {
    expect(stripCodeFence('{"a": 1}')).toBe('{"a": 1}');
  });

  it('trims surrounding whitespace', () => {
    expect(stripCodeFence('   {"a": 1}   ')).toBe('{"a": 1}');
  });
});

describe('isVisionCriticEnabled', () => {
  afterEach(() => {
    process.env.PER_DIAGRAM_VISION_EVAL = '1';
  });

  it('true when env is "1"', () => {
    process.env.PER_DIAGRAM_VISION_EVAL = '1';
    expect(isVisionCriticEnabled()).toBe(true);
  });

  it('true when env is "true"', () => {
    process.env.PER_DIAGRAM_VISION_EVAL = 'true';
    expect(isVisionCriticEnabled()).toBe(true);
  });

  it('false when env is "0"', () => {
    process.env.PER_DIAGRAM_VISION_EVAL = '0';
    expect(isVisionCriticEnabled()).toBe(false);
  });

  it('false when env is unset', () => {
    delete process.env.PER_DIAGRAM_VISION_EVAL;
    expect(isVisionCriticEnabled()).toBe(false);
  });
});

describe('runVisionCritic', () => {
  it('returns skipped:true when env flag is off, without calling Gemini', async () => {
    process.env.PER_DIAGRAM_VISION_EVAL = '0';
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r).toEqual({ verdict: 'PASS', averageScore: 0, skipped: true });
    expect(dummyRenderer.rasterizeSvg).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('returns PASS when the rubric average is at or above 7.5', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '```json\n' + JSON.stringify(buildRubric({ legibility: 9 })) + '\n```',
      },
    });
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('PASS');
    expect(r.averageScore).toBeGreaterThanOrEqual(7.5);
    expect(r.rubric).toBeDefined();
    expect(r.skipped).toBeFalsy();
  });

  it('returns REVISE when the rubric average is below 7.5', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify(
            buildRubric(
              { legibility: 5, hierarchy: 5, whitespace: 5, professionalism: 5, label_clarity: 5, premium_feel: 5 },
              [{ severity: 'high', dimension: 'legibility', fix: 'increase font size 20%' }]
            )
          ),
      },
    });
    const r = await runVisionCritic('<svg/>', { kind: 'tech-radar', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('REVISE');
    expect(r.averageScore).toBe(5);
    expect(r.rubric?.issues).toHaveLength(1);
  });

  it('falls through to PASS with error if rasterize fails', async () => {
    (dummyRenderer.rasterizeSvg as jest.Mock).mockRejectedValueOnce(new Error('chromium crashed'));
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('PASS');
    expect(r.error).toMatch(/rasterize/);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('falls through to PASS with error if Gemini call rejects', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('429 rate limited'));
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('PASS');
    expect(r.error).toMatch(/vision/);
    expect(r.error).toMatch(/429/);
  });

  it('falls through to PASS with error if Gemini returns malformed JSON', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'not json at all' },
    });
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('PASS');
    expect(r.error).toMatch(/vision/);
  });

  it('falls through to PASS with error if Gemini returns schema-mismatched JSON', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ scores: { legibility: 'eight' }, issues: [] }),
      },
    });
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('PASS');
    expect(r.error).toMatch(/vision/);
  });

  it('strips a fenced code block from the response', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '```json\n' + JSON.stringify(buildRubric()) + '\n```',
      },
    });
    const r = await runVisionCritic('<svg/>', { kind: 'sankey', tokens: dummyTokens, renderer: dummyRenderer });
    expect(r.verdict).toBe('PASS');
    expect(r.rubric).toBeDefined();
  });
});
