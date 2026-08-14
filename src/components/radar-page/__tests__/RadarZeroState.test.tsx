/**
 * Component tests for RadarZeroState (LOCAL-010).
 *
 * A workspace with zero radars is a valid durable state; the radar page must
 * render an actionable empty state instead of an empty visualization.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react ESM proxy stub — same pattern as the other radar-page tests.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import { RadarZeroState } from '../RadarZeroState';

describe('RadarZeroState', () => {
  it('renders the zero-radar copy without pretending data exists', () => {
    render(<RadarZeroState onCreateRadar={jest.fn()} onBrowseTechnologies={jest.fn()} />);
    expect(screen.getByText('No radars yet')).toBeInTheDocument();
    expect(screen.getByText(/create your first radar/i)).toBeInTheDocument();
  });

  it('fires onCreateRadar from the primary action', async () => {
    const onCreateRadar = jest.fn();
    const user = userEvent.setup();
    render(<RadarZeroState onCreateRadar={onCreateRadar} onBrowseTechnologies={jest.fn()} />);

    await user.click(screen.getByRole('button', { name: /new radar/i }));
    expect(onCreateRadar).toHaveBeenCalledTimes(1);
  });

  it('fires onBrowseTechnologies from the secondary action', async () => {
    const onBrowseTechnologies = jest.fn();
    const user = userEvent.setup();
    render(<RadarZeroState onCreateRadar={jest.fn()} onBrowseTechnologies={onBrowseTechnologies} />);

    await user.click(screen.getByRole('button', { name: /technology library/i }));
    expect(onBrowseTechnologies).toHaveBeenCalledTimes(1);
  });
});
