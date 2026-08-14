/**
 * @file ContactManager.a11y.test.tsx
 * @description Accessible-name regressions for the scouting contact list
 * (UX-040/ACCESS-001): icon-only per-contact edit/delete controls must carry
 * contextual accessible names including the contact's name.
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

jest.mock('@/lib/contacts', () => ({
  getContactsByCompanyId: jest.fn(),
  createContact: jest.fn(),
  updateContact: jest.fn(),
  deleteContact: jest.fn(),
  setPrimaryContact: jest.fn(),
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ContactManager } from '../ContactManager';
import { getContactsByCompanyId } from '@/lib/contacts';
import type { Contact } from '@/lib/types';

const mockGetContacts = getContactsByCompanyId as jest.MockedFunction<typeof getContactsByCompanyId>;

describe('ContactManager accessible names (UX-040)', () => {
  it('names the per-contact edit and delete icon buttons with the contact name', async () => {
    mockGetContacts.mockResolvedValue([
      {
        id: 'contact-1',
        companyId: 'comp-1',
        name: 'Dana Reyes',
        role: 'CTO',
        email: 'dana@example.com',
        isPrimary: false,
        createdAt: 1,
        updatedAt: 1,
      } as Contact,
    ]);

    render(<ContactManager companyId="comp-1" />);

    expect(await screen.findByRole('button', { name: /edit contact dana reyes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete contact dana reyes/i })).toBeInTheDocument();
  });
});
