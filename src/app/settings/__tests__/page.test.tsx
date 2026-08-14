/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

import type { SystemConfiguration } from '@/lib/types';

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg aria-hidden="true" {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);

jest.mock('@/components/settings/NotificationPanel', () => ({
  NotificationPanel: () => null,
}));

jest.mock('@/components/settings/AgentConfigEditor', () => ({
  AgentConfigEditor: () => null,
}));

jest.mock('@/components/settings/AgentProfilesViewer', () => ({
  AgentProfilesViewer: () => null,
}));

jest.mock('@/components/settings/McpServersStatus', () => ({
  McpServersStatus: () => null,
}));

jest.mock('@/components/settings/McpApiKeysPanel', () => ({
  McpApiKeysPanel: () => null,
}));

jest.mock('@/components/settings/TokenBudgetDashboard', () => ({
  TokenBudgetDashboard: () => null,
}));

jest.mock('@/components/settings/AIAssistantPanel', () => ({
  AIAssistantPanel: () => null,
}));

jest.mock('@/components/layout/AppLayoutV2', () => ({
  SmartLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/lib/system-config', () => ({
  getSystemConfig: jest.fn(),
}));

jest.mock('@/lib/platform-config', () => ({
  getPlatformConfig: jest.fn(),
  updatePlatformConfig: jest.fn(),
}));

import { GeneralSettingsContent } from '../page';

const config = {
  id: 'global',
  notifications: { email: false, dashboard: true },
} as SystemConfiguration;

describe('GeneralSettingsContent', () => {
  it('stacks archive actions on narrow screens and preserves the desktop row', () => {
    render(
      <GeneralSettingsContent
        config={config}
        archiveRetentionDays={90}
        setArchiveRetentionDays={jest.fn()}
        hasChanges={false}
        isSaving={false}
        onSave={jest.fn()}
        onReset={jest.fn()}
        onConfigUpdate={jest.fn()}
      />
    );

    const actions = screen.getByRole('group', { name: 'Archive settings actions' });
    expect(actions).toHaveClass('flex-col', 'gap-2', 'sm:flex-row', 'sm:items-center', 'sm:justify-between');
    expect(actions).not.toHaveClass('justify-between');
    expect(screen.getByRole('button', { name: 'Reset to Defaults' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });
});
