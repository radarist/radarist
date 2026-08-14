/**
 * @file UseCaseManager.a11y.test.tsx
 * @description Accessible-name regressions for the scouting use-case dialog
 * (UX-040/ACCESS-001): the icon-only add-tag button and the per-tag remove
 * control must carry accessible names.
 */

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

jest.mock('@/hooks/use-toast', () => {
  const stableToast = jest.fn();
  return { useToast: () => ({ toast: stableToast }) };
});

jest.mock('@/lib/use-cases', () => ({
  getUseCasesByCompanyId: jest.fn().mockResolvedValue([]),
  createUseCase: jest.fn(),
  linkUseCaseToCompany: jest.fn(),
  unlinkUseCaseFromCompany: jest.fn(),
  getUseCases: jest.fn().mockResolvedValue([]),
}));

jest.mock('../UseCaseDialog', () => ({
  UseCaseDialog: () => null,
}));

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { UseCaseManager } from '../UseCaseManager';

// Radix Dialog + ScrollArea need ResizeObserver in jsdom.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

describe('UseCaseManager accessible names (UX-040)', () => {
  it('names the add-tag button and the per-tag remove control', async () => {
    const user = userEvent.setup();
    render(<UseCaseManager companyId="comp-1" />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /add use case/i }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: /add use case/i })[0]);

    // The tag editor lives in the "Create New" branch of the dialog.
    await user.click(await screen.findByRole('button', { name: /create new/i }));

    const addTagButton = await screen.findByRole('button', { name: /add tag/i });
    expect(addTagButton).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/add a tag/i), 'automation');
    await user.click(addTagButton);

    expect(await screen.findByRole('button', { name: /remove tag automation/i })).toBeInTheDocument();
  });
});
