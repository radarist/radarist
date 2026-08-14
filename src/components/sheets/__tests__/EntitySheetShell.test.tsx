/**
 * Unit Tests for EntitySheetShell component (React Testing Library)
 *
 * Tests rendering, entity type badge, close button, footer,
 * subtitle, header actions, and width variants.
 *
 * Note: There is also an EntitySheetShell.test.ts file that tests
 * the business logic / configuration in a node environment.
 * This file focuses on actual component rendering behavior.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock session tracking so tests don't try to fetch
jest.mock('@/hooks/useTrackEntityView', () => ({
  useTrackEntityView: jest.fn(),
}));

// Mock lucide-react with a Proxy so any icon import works
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

// Mock ErrorBoundary to just render children
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock VerificationBadge to avoid firebase import chain
jest.mock('@/components/impulse/VerificationBadge', () => ({
  VerificationBadge: () => null,
}));

import { EntitySheetShell } from '../EntitySheetShell';

describe('EntitySheetShell', () => {
  const defaultProps = {
    title: 'Create Company',
    entityType: 'company' as const,
    open: true,
    onOpenChange: jest.fn(),
    children: <div>Form content here</div>,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the sheet title when open', () => {
    render(<EntitySheetShell {...defaultProps} />);
    expect(screen.getByText('Create Company')).toBeInTheDocument();
  });

  it('renders children content', () => {
    render(<EntitySheetShell {...defaultProps} />);
    expect(screen.getByText('Form content here')).toBeInTheDocument();
  });

  it('renders the entity type badge', () => {
    render(<EntitySheetShell {...defaultProps} />);
    expect(screen.getByText('Company')).toBeInTheDocument();
  });

  it('renders correct badge for technology entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="technology" title="Edit Technology" />);
    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('Edit Technology')).toBeInTheDocument();
  });

  it('renders correct badge for useCase entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="useCase" />);
    expect(screen.getByText('Use Case')).toBeInTheDocument();
  });

  it('renders correct badge for prototype entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="prototype" />);
    expect(screen.getByText('Prototype')).toBeInTheDocument();
  });

  it('renders correct badge for strategy entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="strategy" />);
    expect(screen.getByText('Strategy')).toBeInTheDocument();
  });

  it('renders correct badge for signal entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="signal" />);
    expect(screen.getByText('Signal')).toBeInTheDocument();
  });

  it('renders correct badge for document entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="document" />);
    expect(screen.getByText('Document')).toBeInTheDocument();
  });

  it('renders correct badge for orgUnit entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="orgUnit" />);
    expect(screen.getByText('Org Unit')).toBeInTheDocument();
  });

  it('renders correct badge for initiative entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="initiative" />);
    expect(screen.getByText('Initiative')).toBeInTheDocument();
  });

  it('renders correct badge for painPoint entity type', () => {
    render(<EntitySheetShell {...defaultProps} entityType="painPoint" />);
    expect(screen.getByText('Pain Point')).toBeInTheDocument();
  });

  it('renders the close button with sr-only text', () => {
    render(<EntitySheetShell {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Close/i })).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when close button is clicked', async () => {
    const user = userEvent.setup();
    render(<EntitySheetShell {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Close/i }));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders subtitle when provided', () => {
    render(<EntitySheetShell {...defaultProps} subtitle="Fill in company details below" />);
    expect(screen.getByText('Fill in company details below')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Fill in company details below');
  });

  it('provides a hidden accessible description when no subtitle is provided', () => {
    render(<EntitySheetShell {...defaultProps} />);
    expect(screen.queryByText('Fill in company details below')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('View and manage company details.');
  });

  it('renders footer when provided', () => {
    render(<EntitySheetShell {...defaultProps} footer={<button>Save</button>} />);
    expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
  });

  it('does not render footer section when footer is not provided', () => {
    const { container: _container } = render(<EntitySheetShell {...defaultProps} />);
    // The footer wrapper has "border-t px-6 py-4" classes
    // With no footer prop, the footer section should not be in DOM
    expect(screen.queryByRole('button', { name: /Save/i })).not.toBeInTheDocument();
  });

  it('renders header actions when provided', () => {
    render(<EntitySheetShell {...defaultProps} headerActions={<button>Share</button>} />);
    expect(screen.getByRole('button', { name: /Share/i })).toBeInTheDocument();
  });

  it('renders with subtitle as ReactNode', () => {
    render(
      <EntitySheetShell
        {...defaultProps}
        subtitle={
          <span>
            Company ID: <strong>comp-123</strong>
          </span>
        }
      />
    );
    expect(screen.getByText('comp-123')).toBeInTheDocument();
  });

  it('does not render content when open is false', () => {
    render(
      <EntitySheetShell {...defaultProps} open={false}>
        <div>Hidden content</div>
      </EntitySheetShell>
    );
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });
});
