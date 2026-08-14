/**
 * @file AIDisclosureBadge.test.tsx
 * @description Unit tests for the unified, review-first AI-disclosure component.
 *
 * Portal-based primitives (Tooltip) and icon packs (lucide-react) are stubbed so
 * the variants render deterministically in jsdom without Radix portal/hover state.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

import { AIDisclosureBadge } from '../AIDisclosureBadge';

jest.mock('lucide-react', () => ({
  Sparkles: ({ className }: { className?: string }) => <span data-testid="sparkles-icon" className={className} />,
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className, ...rest }: { children: React.ReactNode; className?: string }) => (
    <span data-testid="badge" className={className} {...rest}>
      {children}
    </span>
  ),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div data-testid="tooltip">{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div data-testid="tooltip-content">{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div data-testid="tooltip-trigger">{children}</div>,
}));

describe('AIDisclosureBadge', () => {
  describe('inline-badge variant', () => {
    it('renders the Sparkles icon and AI-Generated label', () => {
      render(<AIDisclosureBadge variant="inline-badge" />);
      expect(screen.getByTestId('ai-disclosure-badge')).toBeInTheDocument();
      expect(screen.getByTestId('sparkles-icon')).toBeInTheDocument();
      expect(screen.getByText(/AI-Generated/)).toBeInTheDocument();
    });

    it('renders the confidence % when provided', () => {
      render(<AIDisclosureBadge variant="inline-badge" confidence={85} />);
      expect(screen.getByText(/AI-Generated \(85%\)/)).toBeInTheDocument();
    });

    it('exposes an aria-label and a review-for-accuracy tooltip', () => {
      render(<AIDisclosureBadge variant="inline-badge" />);
      expect(screen.getByTestId('ai-disclosure-badge')).toHaveAttribute('aria-label', 'AI-generated content');
      expect(screen.getByText(/Review it for accuracy/)).toBeInTheDocument();
    });

    it('applies a custom className', () => {
      render(<AIDisclosureBadge variant="inline-badge" className="custom-class" />);
      expect(screen.getByTestId('ai-disclosure-badge')).toHaveClass('custom-class');
    });
  });

  describe('page-disclaimer variant', () => {
    it('renders the disclosure text and a limitations link', () => {
      render(<AIDisclosureBadge variant="page-disclaimer" />);
      expect(screen.getByText(/AI-Assisted Content/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /limitations/i })).toHaveAttribute(
        'href',
        'https://github.com/radarist/radarist/blob/main/docs/LIMITATIONS.md'
      );
    });
  });

  describe('report-footer variant', () => {
    it('renders the footer disclaimer crediting Radarist Studio', () => {
      render(<AIDisclosureBadge variant="report-footer" />);
      expect(screen.getByTestId('ai-disclosure-footer')).toBeInTheDocument();
      expect(screen.getByText(/generated with AI assistance/i)).toBeInTheDocument();
      expect(screen.getByText(/Radarist Studio/)).toBeInTheDocument();
    });
  });
});
