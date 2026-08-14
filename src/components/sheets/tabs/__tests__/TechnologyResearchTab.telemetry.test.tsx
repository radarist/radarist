import { render, screen } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Clock: Icon,
    Sparkles: Icon,
    TrendingUp: Icon,
    BarChart3: Icon,
    Building2: Icon,
    Briefcase: Icon,
    Cpu: Icon,
    DollarSign: Icon,
    Scale: Icon,
    GraduationCap: Icon,
    Telescope: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Target: Icon,
    AlertTriangle: Icon,
  };
});

import { TechnologyResearchTab } from '../TechnologyResearchTab';
import type { TechnologyResearch } from '@/lib/types';

function researchWithUsage(usage: NonNullable<NonNullable<TechnologyResearch['metadata']>['usage']>): TechnologyResearch {
  return {
    lastResearched: 1_800_000_000_000,
    version: 1,
    executiveSummary: { summary: 'Decision-ready research.' },
    metadata: { sources: ['https://example.com/source'], usage },
  };
}

describe('TechnologyResearchTab run telemetry', () => {
  it('shows the persisted served model, request, tokens, and actual cost', () => {
    render(
      <TechnologyResearchTab
        research={researchWithUsage({
          model: 'gemini-2.5-pro',
          requestId: 'req-research-123',
          inputTokens: 1200,
          outputTokens: 340,
          costUsd: 0.1234,
        })}
        researchStatus="completed"
      />
    );

    const telemetry = screen.getByRole('region', { name: 'Research run telemetry' });
    expect(telemetry).toHaveTextContent('gemini-2.5-pro');
    expect(telemetry).toHaveTextContent('1,540 tokens');
    expect(telemetry).toHaveTextContent('$0.1234');
    expect(telemetry).toHaveTextContent('req-research-123');
  });

  it('states unavailable cost and tokens without fabricating zero', () => {
    render(
      <TechnologyResearchTab
        research={researchWithUsage({
          model: 'gemini-unlisted',
          requestId: 'req-unpriced',
          costUnavailableReason: 'No listed pricing for model gemini-unlisted',
        })}
        researchStatus="completed"
      />
    );

    const telemetry = screen.getByRole('region', { name: 'Research run telemetry' });
    expect(telemetry).toHaveTextContent('Tokens unavailable');
    expect(telemetry).toHaveTextContent('Cost unavailable');
    expect(telemetry).not.toHaveTextContent('$0.00');
  });
});
