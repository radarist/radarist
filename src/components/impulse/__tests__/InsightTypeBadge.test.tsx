/**
 * @file InsightTypeBadge.test.tsx
 * @description Tests the four-known + fallback mapping for insight type
 * badges. Lightweight — just confirms each type renders the right label
 * and an unknown type degrades gracefully without throwing.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { InsightTypeBadge } from '../InsightTypeBadge';

describe('InsightTypeBadge', () => {
  it('renders the discovery label', () => {
    render(<InsightTypeBadge type="discovery" />);
    expect(screen.getByText('Discovery')).toBeInTheDocument();
  });

  it('renders the connection label', () => {
    render(<InsightTypeBadge type="connection" />);
    expect(screen.getByText('Connection')).toBeInTheDocument();
  });

  it('renders the pattern label', () => {
    render(<InsightTypeBadge type="pattern" />);
    expect(screen.getByText('Pattern')).toBeInTheDocument();
  });

  it('renders the scoring_change label', () => {
    render(<InsightTypeBadge type="scoring_change" />);
    expect(screen.getByText('Scoring change')).toBeInTheDocument();
  });

  it('falls back gracefully on an unknown future type', () => {
    // Capitalises the raw string so a new server-side type appears as a
    // legible label rather than blowing up the row.
    render(<InsightTypeBadge type={'anomaly' as 'discovery'} />);
    expect(screen.getByText('Anomaly')).toBeInTheDocument();
  });
});
