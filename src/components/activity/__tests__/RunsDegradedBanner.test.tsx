/**
 * @file components/activity/__tests__/RunsDegradedBanner.test.tsx
 * @description Unit coverage for the ARUN-012 partial-degradation banner: it
 * renders nothing when healthy, names the degraded sources in natural
 * language, and wires the Retry button to `onRetry`.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react ESM proxy stub — matches the sibling page tests.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_t, prop: string) => makeIcon(prop) });
});

import { RunsDegradedBanner } from '../RunsDegradedBanner';

describe('RunsDegradedBanner', () => {
  it('renders nothing when there are no degraded sources', () => {
    const { container } = render(<RunsDegradedBanner sources={[]} onRetry={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names a single degraded source with singular grammar', () => {
    render(<RunsDegradedBanner sources={['run history']} onRetry={jest.fn()} />);
    const banner = screen.getByTestId('runs-degraded-banner');
    expect(banner).toHaveTextContent('Some runs may be missing — run history is temporarily unavailable.');
  });

  it('joins two sources with "and" and uses plural grammar', () => {
    render(<RunsDegradedBanner sources={['run history', 'build missions']} onRetry={jest.fn()} />);
    expect(screen.getByTestId('runs-degraded-banner')).toHaveTextContent(
      'run history and build missions are temporarily unavailable.'
    );
  });

  it('joins three or more sources with an Oxford comma', () => {
    render(
      <RunsDegradedBanner sources={['run history', 'build missions', 'in-flight missions']} onRetry={jest.fn()} />
    );
    expect(screen.getByTestId('runs-degraded-banner')).toHaveTextContent(
      'run history, build missions, and in-flight missions are temporarily unavailable.'
    );
  });

  it('is announced as a status region and invokes onRetry when Retry is clicked', async () => {
    const onRetry = jest.fn();
    render(<RunsDegradedBanner sources={['run history']} onRetry={onRetry} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('runs-degraded-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
