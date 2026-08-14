/**
 * AI-028 — render tests for the company Research tab.
 *
 * The tab must present company research as an unverified AI *draft*: an
 * actionable empty state when there is nothing, one restrained
 * "source review required" notice over any generated content, an honest
 * metadata-only state for legacy records, and honest (never fabricated,
 * never verification-implying) provenance counts.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

import { ResearchTab } from '../tabs/ResearchTab';
import { deriveCompanyResearchPresentation } from '@/lib/company-research-presentation';
import type { Company, CompanyResearch } from '@/lib/types';

// lucide-react is ESM; stub every icon as a null-rendering component.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

beforeAll(() => {
  // Radix Collapsible/Progress touch APIs jsdom does not implement.
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

type ResearchInput = Pick<Company, 'research' | 'aiResearch'>;
const present = (input: ResearchInput) => deriveCompanyResearchPresentation(input);

const NARRATIVE: CompanyResearch = {
  lastResearched: Date.now(),
  version: 1,
  executiveSummary: {
    overview: 'Acme builds widgets.',
    keyHighlights: ['Fast growth'],
    recommendation: 'Worth a pilot.',
  },
  financialsAndTraction: {
    totalRaised: '$10M',
    swot: { strengths: ['Strong brand'], weaknesses: [], opportunities: [], threats: [] },
  },
  teamAndLeadership: {
    founders: [{ name: 'Ada Lovelace', role: 'CEO' }],
  },
} as CompanyResearch;

describe('ResearchTab — no research', () => {
  it('keeps the actionable empty state', () => {
    render(<ResearchTab presentation={present({})} />);
    expect(screen.getByText('No research data available')).toBeInTheDocument();
    expect(screen.getByText(/Start Research/i)).toBeInTheDocument();
    expect(screen.queryByText(/AI draft/i)).toBeNull();
  });
});

describe('ResearchTab — AI draft with content', () => {
  const p = present({ research: NARRATIVE });

  it('shows one source-review notice AND keeps every generated section visible', () => {
    render(<ResearchTab presentation={p} />);
    // The draft warning is present, and the generic empty state is not.
    expect(screen.getByText(/source review required/i)).toBeInTheDocument();
    expect(screen.queryByText('No research data available')).toBeNull();
    // Narrative, recommendation, SWOT, and contact all remain visible.
    expect(screen.getByText('Acme builds widgets.')).toBeInTheDocument();
    expect(screen.getByText('Worth a pilot.')).toBeInTheDocument();
    expect(screen.getByText('Strong brand')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('never uses verification / "Researched" language', () => {
    render(<ResearchTab presentation={p} />);
    expect(screen.queryByText(/\bverified\b|\bvalidated\b|decision.?ready/i)).toBeNull();
    expect(screen.queryByText('Researched')).toBeNull();
  });
});

describe('ResearchTab — legacy / metadata-only draft', () => {
  it('shows an honest metadata-only state, not the generic empty state', () => {
    render(<ResearchTab presentation={present({ aiResearch: { lastResearched: Date.now(), data: {} } })} />);
    expect(screen.queryByText('No research data available')).toBeNull();
    expect(screen.getByText(/source review required/i)).toBeInTheDocument();
    expect(screen.getByText(/no detailed sections/i)).toBeInTheDocument();
  });
});

describe('ResearchTab — persisted provenance', () => {
  it('explains unverified citations and renders counts derivable from the document', () => {
    const p = present({
      aiResearch: {
        lastResearched: Date.now(),
        data: {
          citationsVerified: false,
          missingEvidence: ['benchmark', 'pricing'],
          receipts: { description: [{ url: 'https://a.example' }, { url: 'https://b.example' }] },
        },
      },
    });
    render(<ResearchTab presentation={p} />);
    expect(screen.getByText(/AI-suggested/i)).toBeInTheDocument();
    expect(screen.getByText(/2 source references offered/i)).toBeInTheDocument();
    expect(screen.getByText(/2 evidence areas/i)).toBeInTheDocument();
  });

  it('does not fabricate counts for a legacy record without a provenance block', () => {
    render(<ResearchTab presentation={present({ aiResearch: { lastResearched: 1, data: {} } })} />);
    expect(screen.queryByText(/sources offered/i)).toBeNull();
    expect(screen.queryByText(/evidence areas/i)).toBeNull();
  });

  it('does not upgrade sourcingComplete:true into verification wording', () => {
    const p = present({
      aiResearch: {
        lastResearched: 1,
        data: { citationsVerified: false, sourcingComplete: true, missingEvidence: [], receipts: {} },
      },
    });
    render(<ResearchTab presentation={p} />);
    expect(screen.getByText(/source review required/i)).toBeInTheDocument();
    expect(screen.queryByText(/\bverified\b|\bvalidated\b|decision.?ready|sourcing complete/i)).toBeNull();
  });

  it('renders inspectable source references without making hostile schemes clickable', () => {
    const p = present({
      research: {
        ...NARRATIVE,
        metadata: {
          sources: ['https://safe.example/report', 'Company website', 'javascript:alert(1)', 'data:text/html,bad'],
          confidenceScore: 50,
          model: 'gemini',
        },
      },
    });

    render(<ResearchTab presentation={p} />);

    expect(screen.getByRole('link', { name: /safe\.example\/report/i })).toHaveAttribute(
      'href',
      'https://safe.example/report'
    );
    expect(screen.getByText('Company website')).toBeInTheDocument();
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.getByText('data:text/html,bad')).toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector('a[href^="data:"]')).toBeNull();
  });

  it('uses persisted receipt title and publisher for the source link label', () => {
    const p = present({
      aiResearch: {
        lastResearched: 1,
        data: {
          citationsVerified: false,
          receipts: {
            description: [
              {
                url: 'https://source.example/article',
                title: 'Independent analysis',
                publisher: 'Example Journal',
              },
            ],
          },
        },
      },
    });

    render(<ResearchTab presentation={p} />);
    expect(screen.getByRole('link', { name: 'Independent analysis — Example Journal' })).toHaveAttribute(
      'href',
      'https://source.example/article'
    );
  });
});

describe('ResearchTab — external link safety', () => {
  it('renders a safe founder LinkedIn URL as a link', () => {
    render(
      <ResearchTab
        presentation={present({
          research: {
            ...NARRATIVE,
            teamAndLeadership: {
              founders: [{ name: 'Grace Hopper', role: 'Founder', linkedIn: 'https://linkedin.com/in/grace' }],
            },
          },
        })}
      />
    );

    expect(screen.getByRole('link', { name: /Open LinkedIn profile for Grace Hopper/i })).toHaveAttribute(
      'href',
      'https://linkedin.com/in/grace'
    );
  });

  it('never makes a hostile founder LinkedIn value clickable', () => {
    render(
      <ResearchTab
        presentation={present({
          research: {
            ...NARRATIVE,
            teamAndLeadership: {
              founders: [{ name: 'Mallory', role: 'Founder', linkedIn: 'javascript:alert(1)' }],
            },
          },
        })}
      />
    );

    expect(screen.queryByRole('link', { name: /Mallory/i })).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

describe('ResearchTab — loading', () => {
  it('shows the skeleton and suppresses the draft notice while loading', () => {
    render(<ResearchTab presentation={present({ research: NARRATIVE })} isLoading />);
    expect(screen.queryByText(/source review required/i)).toBeNull();
  });
});

describe('ResearchTab — confidence honesty', () => {
  it('labels the model self-reported confidence as AI-estimated, not a verified metric', () => {
    const p = present({
      research: {
        lastResearched: Date.now(),
        version: 1,
        executiveSummary: { overview: 'x', keyHighlights: [] },
        metadata: { sources: ['https://a.example'], confidenceScore: 95, model: 'gemini' },
      } as CompanyResearch,
    });
    render(<ResearchTab presentation={p} />);
    expect(screen.getByText(/AI-estimated confidence/i)).toBeInTheDocument();
    expect(screen.queryByText('Confidence: 95%')).toBeNull();
    expect(screen.getByText(/1 source reference offered/i)).toBeInTheDocument();
    expect(screen.queryByText(/^1 sources$/i)).toBeNull();
  });
});
