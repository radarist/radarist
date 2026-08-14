/**
 * @file WhyAmISeeingThis.test.tsx
 * @description Tests the breadcrumb's structured vs fallback rendering.
 *
 * Pins:
 *   1. Renders the structured sentence when A.0 path data is present.
 *   2. Falls back to the raw summary when any of `relationshipTypes`,
 *      `pathLength`, or the endpoint IDs are missing.
 *   3. Resolves entity names from the supplied map, falling back to
 *      the id when not in the map.
 *   4. Drops the relative-time phrase when `exploredAt` is absent.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { WhyAmISeeingThis } from '../WhyAmISeeingThis';
import type { BriefingInsight } from '@/hooks/useBriefing';

// Stub the lucide icon used by the tooltip trigger — ESM import would
// fail in Jest's CJS transform otherwise.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

function makeInsight(overrides: Partial<BriefingInsight> = {}): BriefingInsight {
  return {
    id: 'pi-1',
    type: 'connection',
    title: 'Quantum link',
    summary: 'Path goes through VENDOR → USES — old fallback rationale.',
    agentName: 'scout',
    confidenceScore: 0.8,
    relatedEntities: [
      { id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' },
      { id: 'comp-ibm', name: 'IBM', type: 'company' },
    ],
    observedEntityId: 'comp-ibm',
    exploredEntityId: 'tech-quantum',
    actionable: true,
    actionUrl: '/library/companies?sheet=comp-ibm',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    relationshipTypes: ['VENDOR', 'USES'],
    pathLength: 2,
    exploredAt: '2026-05-10T12:00:00.000Z',
    ...overrides,
  };
}

const NAMES = new Map<string, string>([
  ['tech-quantum', 'Quantum Computing'],
  ['comp-ibm', 'IBM'],
]);

describe('WhyAmISeeingThis', () => {
  it('renders the structured sentence when A.0 path data is present', () => {
    render(<WhyAmISeeingThis insight={makeInsight()} entityNamesById={NAMES} />);
    expect(screen.getByTestId('why-structured')).toBeInTheDocument();
    // Both endpoint entity names are interpolated.
    expect(screen.getByText(/Quantum Computing/)).toBeInTheDocument();
    expect(screen.getByText(/IBM/)).toBeInTheDocument();
    // The relationship chain renders inside a <code>.
    expect(screen.getByText('VENDOR → USES')).toBeInTheDocument();
    // Path length phrased correctly (`2 hops`, not `2 hop`).
    expect(screen.getByText(/2 hops/)).toBeInTheDocument();
  });

  it('says "1 hop" (not "1 hops") when pathLength is 1', () => {
    render(
      <WhyAmISeeingThis
        insight={makeInsight({ pathLength: 1, relationshipTypes: ['VENDOR'] })}
        entityNamesById={NAMES}
      />
    );
    // The phrase is split across text + spans; assert against the
    // textContent of the breadcrumb wrapper rather than a single node.
    const breadcrumb = screen.getByTestId('why-structured');
    expect(breadcrumb.textContent).toMatch(/1 hop away/);
    expect(breadcrumb.textContent).not.toMatch(/1 hops away/);
  });

  it('omits the relative-time phrase when exploredAt is absent', () => {
    render(<WhyAmISeeingThis insight={makeInsight({ exploredAt: undefined })} entityNamesById={NAMES} />);
    // No "ago" in the rendered text — Jest's screen.queryByText matches
    // accessible text content, which excludes the path-data attributes.
    const breadcrumb = screen.getByTestId('why-structured');
    expect(breadcrumb.textContent).not.toMatch(/ago/);
    // The endpoint names still appear.
    expect(screen.getByText(/Quantum Computing/)).toBeInTheDocument();
  });

  it('falls back to the raw summary when relationshipTypes is missing', () => {
    render(<WhyAmISeeingThis insight={makeInsight({ relationshipTypes: undefined })} entityNamesById={NAMES} />);
    expect(screen.getByTestId('why-fallback')).toBeInTheDocument();
    expect(screen.getByText(/old fallback rationale/)).toBeInTheDocument();
  });

  it('falls back when pathLength is missing', () => {
    render(<WhyAmISeeingThis insight={makeInsight({ pathLength: undefined })} entityNamesById={NAMES} />);
    expect(screen.getByTestId('why-fallback')).toBeInTheDocument();
  });

  it('falls back when the endpoint IDs are missing', () => {
    render(<WhyAmISeeingThis insight={makeInsight({ observedEntityId: undefined })} entityNamesById={NAMES} />);
    expect(screen.getByTestId('why-fallback')).toBeInTheDocument();
  });

  it('falls back when relationshipTypes is an empty array', () => {
    render(<WhyAmISeeingThis insight={makeInsight({ relationshipTypes: [] })} entityNamesById={NAMES} />);
    expect(screen.getByTestId('why-fallback')).toBeInTheDocument();
  });

  it('uses the entity id verbatim when not in the name map', () => {
    const empty = new Map<string, string>();
    render(<WhyAmISeeingThis insight={makeInsight()} entityNamesById={empty} />);
    // No friendly names — the breadcrumb still renders without throwing.
    expect(screen.getByTestId('why-structured')).toBeInTheDocument();
    expect(screen.getByText(/tech-quantum/)).toBeInTheDocument();
    expect(screen.getByText(/comp-ibm/)).toBeInTheDocument();
  });

  it('renders grounded generic semantics and reversed direction without inventing forward arrows', () => {
    render(
      <WhyAmISeeingThis
        insight={makeInsight({
          epistemicKind: 'inference',
          groundingVersion: 'predicate-path-v1',
          sourceRelationTypes: ['aligns_with', 'supplier_of'],
          relationshipDirections: ['forward', 'reverse'],
          evidenceSummary:
            'technology "Quantum Computing" -[ALIGNS_WITH]-> strategy "Quantum Strategy" <-[SUPPLIER_OF]- company "IBM"',
        })}
        entityNamesById={NAMES}
      />
    );

    const breadcrumb = screen.getByTestId('why-structured');
    expect(breadcrumb.textContent).toContain('inferred that IBM may be 2 hops away');
    expect(
      screen.getByText(
        'technology "Quantum Computing" -[ALIGNS_WITH]-> strategy "Quantum Strategy" <-[SUPPLIER_OF]- company "IBM"'
      )
    ).toBeInTheDocument();
    expect(breadcrumb.textContent).not.toContain('RELATED_TO');
  });
});

// ---------------------------------------------------------------------------
// UX-048 — Summary and provenance must not duplicate each other
// ---------------------------------------------------------------------------

describe('WhyAmISeeingThis — UX-048 non-duplicative provenance', () => {
  const WATCH_SUMMARY = 'An entity you explored was updated after your last visit — open it to see what changed.';

  /**
   * Interest Watch shape: no structured path, one ABOUT entity, agent-observation
   * grounding. (At runtime these rows carry `type: 'update'`, a value the declared
   * BriefingInsight union doesn't list — a pre-existing typing divergence that
   * renders harmlessly as a muted "Update" badge. The branch under test keys off
   * `agentName`, not `type`, so the fixture leaves the declared type alone.)
   */
  function makeWatchInsight(overrides: Partial<BriefingInsight> = {}): BriefingInsight {
    return makeInsight({
      agentName: 'interest-watch',
      groundingVersion: 'agent-observation-v1',
      summary: WATCH_SUMMARY,
      relationshipTypes: undefined,
      pathLength: undefined,
      observedEntityId: undefined,
      exploredEntityId: undefined,
      exploredAt: undefined,
      evidenceSummary: undefined,
      relatedEntities: [{ id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' }],
      ...overrides,
    });
  }

  it('Interest Watch: renders user-scoped provenance, never a second copy of the summary', () => {
    render(<WhyAmISeeingThis insight={makeWatchInsight()} entityNamesById={NAMES} visibleSummary={WATCH_SUMMARY} />);

    expect(screen.getByTestId('why-watch')).toBeInTheDocument();
    // Provenance names the viewed entity and the watch source.
    expect(screen.getByText(/Quantum Computing/)).toBeInTheDocument();
    expect(screen.getByText(/you viewed/i)).toBeInTheDocument();
    // The Summary text above must NOT be repeated here.
    expect(screen.queryByText(WATCH_SUMMARY)).toBeNull();
    // And it must not invent a change payload that was never captured.
    expect(screen.queryByText(/changed from/i)).toBeNull();
  });

  it('Interest Watch: includes the detection timestamp when createdAt is usable', () => {
    render(
      <WhyAmISeeingThis
        insight={makeWatchInsight({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })}
        entityNamesById={NAMES}
        visibleSummary={WATCH_SUMMARY}
      />
    );
    expect(screen.getByText(/hours ago/i)).toBeInTheDocument();
  });

  it('Interest Watch: omits the timestamp phrase entirely when createdAt is unusable', () => {
    render(
      <WhyAmISeeingThis
        insight={makeWatchInsight({ createdAt: 'not-a-date' })}
        entityNamesById={NAMES}
        visibleSummary={WATCH_SUMMARY}
      />
    );
    expect(screen.getByTestId('why-watch')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/ago/i)).toBeNull();
  });

  it('structured path is unaffected by the visibleSummary prop', () => {
    render(
      <WhyAmISeeingThis
        insight={makeInsight()}
        entityNamesById={NAMES}
        visibleSummary="Path goes through VENDOR → USES — old fallback rationale."
      />
    );
    expect(screen.getByTestId('why-structured')).toBeInTheDocument();
  });

  it('legacy distinct rationale: still rendered, labeled as the recorded rationale', () => {
    render(
      <WhyAmISeeingThis
        insight={makeInsight({
          relationshipTypes: undefined,
          summary: 'IBM is a vendor for the quantum platform.',
          evidenceSummary: 'Matched because the vendor edge was refreshed last week.',
        })}
        entityNamesById={NAMES}
        visibleSummary="IBM is a vendor for the quantum platform."
      />
    );
    expect(screen.getByTestId('why-fallback')).toBeInTheDocument();
    expect(screen.getByText(/vendor edge was refreshed last week/)).toBeInTheDocument();
    // The visible summary is not echoed a second time.
    expect(screen.queryByText('IBM is a vendor for the quantum platform.')).toBeNull();
  });

  it('equal text: renders the rationale ONCE with an honest fallback label instead of duplicating it', () => {
    const summary = 'Path goes through VENDOR → USES — old fallback rationale.';
    render(
      <WhyAmISeeingThis
        insight={makeInsight({ relationshipTypes: undefined, summary })}
        entityNamesById={NAMES}
        visibleSummary={summary}
      />
    );
    expect(screen.getByTestId('why-fallback')).toBeInTheDocument();
    expect(screen.queryByText(summary)).toBeNull();
    expect(screen.getByText(/no additional provenance was captured/i)).toBeInTheDocument();
  });

  it('equal text: normalization ignores case, whitespace and trailing punctuation', () => {
    render(
      <WhyAmISeeingThis
        insight={makeInsight({ relationshipTypes: undefined, summary: '  The Vendor   Edge Was Refreshed  ' })}
        entityNamesById={NAMES}
        visibleSummary="the vendor edge was refreshed."
      />
    );
    expect(screen.getByText(/no additional provenance was captured/i)).toBeInTheDocument();
  });

  it('without a visibleSummary prop the legacy rationale is still shown (standalone use)', () => {
    render(<WhyAmISeeingThis insight={makeInsight({ relationshipTypes: undefined })} entityNamesById={NAMES} />);
    expect(screen.getByText(/old fallback rationale/)).toBeInTheDocument();
  });

  it('accessibility: every mode labels its region with an accessible heading', () => {
    const modes = [makeInsight(), makeWatchInsight(), makeInsight({ relationshipTypes: undefined })];
    for (const insight of modes) {
      const { unmount } = render(
        <WhyAmISeeingThis insight={insight} entityNamesById={NAMES} visibleSummary={insight.summary} />
      );
      const heading = screen.getByRole('heading', { name: /why am i seeing this/i });
      expect(heading).toBeInTheDocument();
      const region = screen.getByRole('region', { name: /why am i seeing this/i });
      expect(region).toBeInTheDocument();
      unmount();
    }
  });
});
