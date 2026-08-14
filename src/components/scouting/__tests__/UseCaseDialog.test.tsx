/**
 * Component tests for UseCaseDialog (React Testing Library).
 *
 * Regression guard (F4): the edit path used to bypass the service layer with a
 * raw `updateDoc(doc(db,'use-cases',id), …)`, so use-case edits never triggered
 * the Neo4j entity sync and any `undefined` field made updateDoc throw. The
 * dialog now routes edits through `updateUseCase()`. These tests pin that:
 *
 *   1. Editing an existing use case calls `updateUseCase(id, updates)` (which
 *      internally fires the graph sync) and NOT `createUseCase`.
 *   2. `id`/`createdAt` are not forwarded in the update payload.
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

// Break the Firebase init chain; the dialog must not touch Firestore directly.
jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/lib/use-cases', () => ({
  createUseCase: jest.fn(),
  updateUseCase: jest.fn().mockResolvedValue(undefined),
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { UseCaseDialog } from '../UseCaseDialog';
import type { UseCase } from '@/lib/types';

const { createUseCase, updateUseCase } = jest.requireMock('@/lib/use-cases');

const baseUseCase: UseCase = {
  id: 'usecase-1',
  slug: 'predictive-maintenance',
  title: 'Predictive Maintenance',
  description: 'desc',
  createdAt: 1000,
  updatedAt: 2000,
} as UseCase;

describe('UseCaseDialog edit path (F4 regression)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes an edit through updateUseCase(), not a raw updateDoc / createUseCase', async () => {
    const user = userEvent.setup();
    render(<UseCaseDialog isOpen useCase={baseUseCase} onOpenChange={() => {}} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateUseCase).toHaveBeenCalledTimes(1);
    expect(createUseCase).not.toHaveBeenCalled();

    const [id, updates] = updateUseCase.mock.calls[0];
    expect(id).toBe('usecase-1');
    // id/createdAt are audit-managed and must not be forwarded in the payload.
    expect(updates).not.toHaveProperty('id');
    expect(updates).not.toHaveProperty('createdAt');
    expect(updates).toMatchObject({ title: 'Predictive Maintenance' });
  });
});
