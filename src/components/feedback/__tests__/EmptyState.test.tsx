/**
 * Unit Tests for EmptyState and EmptyStateCard components
 *
 * Tests rendering, action callbacks, optional props, and size variants.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  FileQuestion: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="icon-file-question" {...props} />
  ),
  Plus: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="icon-plus" {...props} />
  ),
  Radio: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="icon-radio" {...props} />
  ),
  Download: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="icon-download" {...props} />
  ),
}));

import { EmptyState, EmptyStateCard } from '../EmptyState';
import { Plus, Radio, Download } from 'lucide-react';

describe('EmptyState', () => {
  const defaultProps = {
    title: 'No signals detected',
    action: {
      label: 'Import Signals',
      onClick: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the title', () => {
    render(<EmptyState {...defaultProps} />);
    expect(screen.getByText('No signals detected')).toBeInTheDocument();
  });

  it('renders the primary action button', () => {
    render(<EmptyState {...defaultProps} />);
    expect(
      screen.getByRole('button', { name: /Import Signals/i })
    ).toBeInTheDocument();
  });

  it('calls action.onClick when primary button is clicked', async () => {
    const user = userEvent.setup();
    render(<EmptyState {...defaultProps} />);

    await user.click(
      screen.getByRole('button', { name: /Import Signals/i })
    );

    expect(defaultProps.action.onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the default FileQuestion icon when no icon is provided', () => {
    render(<EmptyState {...defaultProps} />);
    expect(screen.getByTestId('icon-file-question')).toBeInTheDocument();
  });

  it('renders a custom icon when provided', () => {
    render(<EmptyState {...defaultProps} icon={Radio} />);
    expect(screen.getByTestId('icon-radio')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(
      <EmptyState
        {...defaultProps}
        description="Start by importing signals from external sources."
      />
    );
    expect(
      screen.getByText('Start by importing signals from external sources.')
    ).toBeInTheDocument();
  });

  it('does not render description when not provided', () => {
    const { container } = render(<EmptyState {...defaultProps} />);
    // The <p> tag for description should not be present
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(0);
  });

  it('renders a secondary action button when provided', () => {
    const secondaryAction = {
      label: 'Learn More',
      onClick: jest.fn(),
    };

    render(
      <EmptyState {...defaultProps} secondaryAction={secondaryAction} />
    );

    expect(
      screen.getByRole('button', { name: /Learn More/i })
    ).toBeInTheDocument();
  });

  it('calls secondaryAction.onClick when secondary button is clicked', async () => {
    const user = userEvent.setup();
    const secondaryAction = {
      label: 'Learn More',
      onClick: jest.fn(),
    };

    render(
      <EmptyState {...defaultProps} secondaryAction={secondaryAction} />
    );

    await user.click(
      screen.getByRole('button', { name: /Learn More/i })
    );

    expect(secondaryAction.onClick).toHaveBeenCalledTimes(1);
  });

  it('renders action button icon when provided', () => {
    render(
      <EmptyState
        {...defaultProps}
        action={{ ...defaultProps.action, icon: Plus }}
      />
    );
    expect(screen.getByTestId('icon-plus')).toBeInTheDocument();
  });

  it('renders secondary action button icon when provided', () => {
    render(
      <EmptyState
        {...defaultProps}
        secondaryAction={{
          label: 'Download',
          onClick: jest.fn(),
          icon: Download,
        }}
      />
    );
    expect(screen.getByTestId('icon-download')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <EmptyState {...defaultProps} className="my-custom-class" />
    );
    expect(container.firstChild).toHaveClass('my-custom-class');
  });

  it('renders with sm size variant', () => {
    const { container } = render(
      <EmptyState {...defaultProps} size="sm" />
    );
    expect(container.firstChild).toHaveClass('py-8');
  });

  it('renders with md size variant (default)', () => {
    const { container } = render(<EmptyState {...defaultProps} />);
    expect(container.firstChild).toHaveClass('py-12');
  });

  it('renders with lg size variant', () => {
    const { container } = render(
      <EmptyState {...defaultProps} size="lg" />
    );
    expect(container.firstChild).toHaveClass('py-16');
  });
});

describe('EmptyStateCard', () => {
  const defaultProps = {
    title: 'No data',
    action: {
      label: 'Add Data',
      onClick: jest.fn(),
    },
  };

  it('renders EmptyState within a card wrapper', () => {
    const { container } = render(<EmptyStateCard {...defaultProps} />);
    // The outer wrapper should have border-dashed
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('rounded-lg');
    expect(card).toHaveClass('border-dashed');
  });

  it('passes all props through to EmptyState', () => {
    render(
      <EmptyStateCard
        {...defaultProps}
        description="Add data to get started"
      />
    );
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('Add data to get started')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add Data/i })
    ).toBeInTheDocument();
  });
});
