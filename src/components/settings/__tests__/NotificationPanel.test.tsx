/**
 * @file NotificationPanel.test.tsx
 * @description Tests for the notifications settings panel.
 *
 * Audit fix: the panel previously rendered a permanently-unreachable Save
 * button (every editable control was disabled, so hasChanges() could never
 * become true). The panel is now honest read-only UI: Coming-Soon cards with
 * no dead Save flow.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

import type { SystemConfiguration, NotificationConfig } from '@/lib/types';

// Mock lucide-react with a Proxy so any icon import works
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

import { NotificationPanel } from '../NotificationPanel';

function makeConfig(notifications: Partial<NotificationConfig> = {}): SystemConfiguration {
  const base: Pick<SystemConfiguration, 'id' | 'notifications'> = {
    id: 'global',
    notifications: {
      email: false,
      dashboard: true,
      ...notifications,
    },
  };
  // Only id + notifications are read by the panel; the remaining agent/signal
  // config sections are irrelevant here.
  return base as SystemConfiguration;
}

describe('NotificationPanel', () => {
  it('renders no Save button (all channels are read-only)', () => {
    render(<NotificationPanel config={makeConfig()} />);

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('shows the dashboard channel as always on with 1 channel enabled by default', () => {
    render(<NotificationPanel config={makeConfig()} />);

    expect(screen.getByText('Always On')).toBeInTheDocument();
    expect(screen.getByText('1 channel')).toBeInTheDocument();
  });

  it('counts email and slack channels from the persisted config', () => {
    render(<NotificationPanel config={makeConfig({ email: true, slack: 'https://hooks.slack.com/services/T/B/X' })} />);

    expect(screen.getByText('3 channels')).toBeInTheDocument();
  });

  it('renders email as a disabled Coming Soon toggle', () => {
    render(<NotificationPanel config={makeConfig()} />);

    expect(screen.getByText('Coming Soon')).toBeInTheDocument();
    const emailSwitch = screen.getByRole('switch', { name: 'Email notifications' });
    expect(emailSwitch).toBeDisabled();
  });

  it('renders the Slack webhook input disabled and marked Not Available', () => {
    render(<NotificationPanel config={makeConfig({ slack: 'https://hooks.slack.com/services/T/B/X' })} />);

    expect(screen.getByText('Not Available')).toBeInTheDocument();
    const input = screen.getByLabelText('Slack Webhook URL');
    expect(input).toBeDisabled();
    expect(input).toHaveValue('https://hooks.slack.com/services/T/B/X');
  });
});
