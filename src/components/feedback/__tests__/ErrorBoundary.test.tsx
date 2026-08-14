/**
 * Unit Tests for ErrorBoundary, ErrorFallback, and withErrorBoundary
 *
 * Tests error catching, fallback rendering, reset behavior, and HOC wrapping.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  AlertCircle: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="icon-alert-circle" {...props} />
  ),
  RefreshCw: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="icon-refresh" {...props} />
  ),
}));

import {
  ErrorBoundary,
  ErrorFallback,
  withErrorBoundary,
} from '../ErrorBoundary';

// Suppress console.error output in tests where we intentionally throw
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});
afterAll(() => {
  console.error = originalConsoleError;
});

// A component that always throws during render
function ThrowingComponent({ message }: { message?: string }): JSX.Element {
  throw new Error(message || 'Test error');
}

// A component that can be toggled to throw
function _ConditionalThrow({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Conditional error');
  }
  return <div>Normal content</div>;
}

describe('ErrorFallback', () => {
  const defaultProps = {
    error: new Error('Something broke'),
    reset: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the default title', () => {
    render(<ErrorFallback {...defaultProps} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders a custom title when provided', () => {
    render(<ErrorFallback {...defaultProps} title="Custom Error Title" />);
    expect(screen.getByText('Custom Error Title')).toBeInTheDocument();
  });

  it('renders the error message as description', () => {
    render(<ErrorFallback {...defaultProps} />);
    expect(screen.getByText('Something broke')).toBeInTheDocument();
  });

  it('renders a custom description when provided', () => {
    render(
      <ErrorFallback
        {...defaultProps}
        description="Please contact support."
      />
    );
    expect(screen.getByText('Please contact support.')).toBeInTheDocument();
  });

  it('renders fallback message when error is null', () => {
    render(<ErrorFallback error={null} reset={jest.fn()} />);
    expect(
      screen.getByText('An unexpected error occurred. Please try again.')
    ).toBeInTheDocument();
  });

  it('renders the Try again button', () => {
    render(<ErrorFallback {...defaultProps} />);
    expect(
      screen.getByRole('button', { name: /Try again/i })
    ).toBeInTheDocument();
  });

  it('calls reset when Try again is clicked', async () => {
    const user = userEvent.setup();
    const resetFn = jest.fn();
    render(<ErrorFallback error={new Error('err')} reset={resetFn} />);

    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(resetFn).toHaveBeenCalledTimes(1);
  });

  it('applies custom className', () => {
    const { container } = render(
      <ErrorFallback {...defaultProps} className="custom-error-class" />
    );
    expect(container.firstChild).toHaveClass('custom-error-class');
  });

  it('shows error details in development mode', () => {
    const originalEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      writable: true,
    });

    const error = new Error('Dev error');
    error.stack = 'Error: Dev error\n    at test.tsx:10';
    render(<ErrorFallback error={error} reset={jest.fn()} />);

    expect(screen.getByText(/Error details/i)).toBeInTheDocument();

    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      writable: true,
    });
  });
});

describe('ErrorBoundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div>Safe content</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Safe content')).toBeInTheDocument();
  });

  it('renders default ErrorFallback when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Try again/i })
    ).toBeInTheDocument();
  });

  it('renders custom fallback element when provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
  });

  it('renders fallbackRender when provided', () => {
    render(
      <ErrorBoundary
        fallbackRender={({ error, reset }) => (
          <div>
            <span>Render: {error.message}</span>
            <button onClick={reset}>Retry</button>
          </div>
        )}
      >
        <ThrowingComponent message="fallbackRender test" />
      </ErrorBoundary>
    );
    expect(
      screen.getByText('Render: fallbackRender test')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('calls onError callback when an error is caught', () => {
    const onErrorFn = jest.fn();
    render(
      <ErrorBoundary onError={onErrorFn}>
        <ThrowingComponent message="callback test" />
      </ErrorBoundary>
    );
    expect(onErrorFn).toHaveBeenCalledTimes(1);
    expect(onErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'callback test' }),
      expect.objectContaining({ componentStack: expect.any(String) })
    );
  });

  it('resets state when Try again is clicked in default fallback', async () => {
    const user = userEvent.setup();

    // We use a ref to control whether the child throws
    let shouldThrow = true;
    function MaybeThrow() {
      if (shouldThrow) throw new Error('Reset test');
      return <div>Recovered!</div>;
    }

    const { rerender: _rerender } = render(
      <ErrorBoundary>
        <MaybeThrow />
      </ErrorBoundary>
    );

    // Error state shown
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Stop throwing, then click Try again
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(screen.getByText('Recovered!')).toBeInTheDocument();
  });

  it('displays the error message from the thrown error', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="Specific error message" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Specific error message')).toBeInTheDocument();
  });

  it('prefers fallbackRender over fallback element', () => {
    render(
      <ErrorBoundary
        fallback={<div>Fallback element</div>}
        fallbackRender={() => <div>Fallback render</div>}
      >
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Fallback render')).toBeInTheDocument();
    expect(screen.queryByText('Fallback element')).not.toBeInTheDocument();
  });
});

describe('withErrorBoundary', () => {
  it('wraps a component in an ErrorBoundary', () => {
    function GoodComponent() {
      return <div>Wrapped content</div>;
    }
    const SafeComponent = withErrorBoundary(GoodComponent);

    render(<SafeComponent />);
    expect(screen.getByText('Wrapped content')).toBeInTheDocument();
  });

  it('catches errors from the wrapped component', () => {
    function BadComponent(): React.ReactNode {
      throw new Error('HOC error');
    }
    const SafeComponent = withErrorBoundary(BadComponent);

    render(<SafeComponent />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('passes custom ErrorBoundary props', () => {
    function BadComponent(): React.ReactNode {
      throw new Error('HOC error');
    }
    const SafeComponent = withErrorBoundary(BadComponent, {
      fallback: <div>Custom HOC fallback</div>,
    });

    render(<SafeComponent />);
    expect(screen.getByText('Custom HOC fallback')).toBeInTheDocument();
  });

  it('sets displayName on the wrapped component', () => {
    function MyComponent() {
      return <div />;
    }
    const Wrapped = withErrorBoundary(MyComponent);

    expect(Wrapped.displayName).toBe('withErrorBoundary(MyComponent)');
  });
});
