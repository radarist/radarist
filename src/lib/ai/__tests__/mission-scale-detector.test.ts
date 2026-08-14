import {
  isMissionScalePrompt,
  INLINE_REPORT_TOOLS_TO_HIDE,
  MISSION_BOUND_REPORT_TOOLS_TO_HIDE,
} from '../mission-scale-detector';

describe('isMissionScalePrompt', () => {
  describe('returns true for mission-scale signals', () => {
    const positiveCases = [
      // Multi-section deliverable
      'Generate a full strategy report on AI in 2026',
      'Create a comprehensive report on competitive positioning',
      'Write a strategy report covering Q4 priorities',
      'Give me a deep dive on autonomous vehicles',
      'Build an executive briefing for the board',

      // Strategic roadmaps / FY plans
      'Create an FY26 plan for our innovation portfolio',
      'Build an FY-26 strategic roadmap',
      'Generate a strategic roadmap for cloud migration',
      'Build our annual outlook for emerging tech',
      'Build a 5-year strategy for our R&D org',
      'Build a 3 year roadmap for AI adoption',

      // Agent-style dispatch language
      'Dispatch the creator agent to write our annual review',
      'Send a strategist to map this opportunity',
      'Run a mission on emerging vendor risks',
      'I want background work on the LangChain ecosystem',
      'Kick off a background job to compile vendor cards',

      // Multiple-diagram requests
      'Generate a report and embed FOUR diagrams',
      'Make a report with three inline charts',
      'Create a deck with 5 embedded visualizations',
    ];

    test.each(positiveCases)('matches: %s', (msg) => {
      expect(isMissionScalePrompt(msg)).toBe(true);
    });
  });

  describe('returns false for normal chat / single-topic asks', () => {
    const negativeCases = [
      // Quick lookups
      'What do we know about Acme Corp?',
      'Show me all radars',
      'List the signals from yesterday',
      'How is mission xyz going?',

      // Single-topic short reports (handled inline)
      'Create a quick one-pager on LangChain',
      'Write a short report about our top 3 tech bets',
      'Make a report about our LLM stack',

      // Single chart requests
      'Render a sankey for the adoption funnel',
      'Embed a tech-radar of the master radar',
      'Show the data as a bubble chart',

      // Conversational
      'Hello',
      "What's the difference between Wardley and TRL?",
      'Can you explain Cynefin?',

      // Empty / nullish
      '',
    ];

    test.each(negativeCases)('does not match: %s', (msg) => {
      expect(isMissionScalePrompt(msg)).toBe(false);
    });
  });

  it('handles a trailing/leading whitespace and punctuation', () => {
    expect(isMissionScalePrompt('   create a full strategy report.   ')).toBe(true);
    expect(isMissionScalePrompt('Please generate a comprehensive report!')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMissionScalePrompt('GENERATE A FULL STRATEGY REPORT')).toBe(true);
    expect(isMissionScalePrompt('Generate A Full Strategy Report')).toBe(true);
    expect(isMissionScalePrompt('generate a full strategy report')).toBe(true);
  });

  it('does not false-positive on substring overlaps', () => {
    // "comprehensive coverage" should not match comprehensive-report
    expect(isMissionScalePrompt('Give us comprehensive coverage of the issue')).toBe(false);
    // "embed link" not embed-N-diagrams
    expect(isMissionScalePrompt('Can you embed a link to the source?')).toBe(false);
  });
});

describe('INLINE_REPORT_TOOLS_TO_HIDE', () => {
  it('lists the inline report-construction tools', () => {
    expect(INLINE_REPORT_TOOLS_TO_HIDE).toContain('draftReport');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).toContain('publishReport');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).toContain('renderDiagram');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).toContain('createResearchDocument');
  });

  it('does NOT include the removed createAndSaveReport alias (Phase C)', () => {
    // Phase C removed the legacy alias entirely; the hide list must not
    // reference it anymore — load-bearing guard against accidental re-add.
    expect(INLINE_REPORT_TOOLS_TO_HIDE).not.toContain('createAndSaveReport');
  });

  it('does NOT include mission/lookup tools', () => {
    expect(INLINE_REPORT_TOOLS_TO_HIDE).not.toContain('startMission');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).not.toContain('getMissionStatus');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).not.toContain('listUserMissions');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).not.toContain('listReports');
    expect(INLINE_REPORT_TOOLS_TO_HIDE).not.toContain('getReportById');
  });
});

describe('MISSION_BOUND_REPORT_TOOLS_TO_HIDE', () => {
  it('keeps Creator-only persistence tools off every interactive turn', () => {
    expect(MISSION_BOUND_REPORT_TOOLS_TO_HIDE).toEqual(['draftReport', 'publishReport']);
  });
});
