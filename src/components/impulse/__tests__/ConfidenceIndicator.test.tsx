/**
 * @file ConfidenceIndicator.test.tsx
 * @description Tests the percentage rendering + accessibility label of
 * the confidence indicator. The dial geometry isn't worth snapshot-
 * testing — pinning the rounded percentage and the aria-label is enough.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ConfidenceIndicator } from '../ConfidenceIndicator';

describe('ConfidenceIndicator', () => {
  it('rounds the score to a whole percentage', () => {
    render(<ConfidenceIndicator score={0.876} />);
    expect(screen.getByText('88%')).toBeInTheDocument();
  });

  it('exposes the percentage via aria-label for screen readers', () => {
    render(<ConfidenceIndicator score={0.5} />);
    expect(screen.getByLabelText('Confidence 50%')).toBeInTheDocument();
  });

  it('clamps a stray > 1 score (defensive against future server bugs)', () => {
    render(<ConfidenceIndicator score={1.5} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('clamps a stray negative score', () => {
    render(<ConfidenceIndicator score={-0.3} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('hides the trailing label when `hideLabel` is set', () => {
    render(<ConfidenceIndicator score={0.42} hideLabel />);
    expect(screen.queryByText('42%')).not.toBeInTheDocument();
    // The aria-label still carries the value for assistive tech.
    expect(screen.getByLabelText('Confidence 42%')).toBeInTheDocument();
  });
});
