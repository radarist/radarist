/**
 * @file CompanyRadarLinks.a11y.test.tsx
 * @description Accessible-name regression for the scouting radar-link list
 * (UX-040/ACCESS-001): the icon-only delete-link control must carry a
 * contextual accessible name including the resolved entry name.
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

jest.mock('@/lib/company-relationships', () => ({
  getRelationshipsByCompanyId: jest.fn(),
  linkCompanyToBlip: jest.fn(),
  unlinkCompanyFromBlip: jest.fn(),
}));

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  getDocs: jest.fn().mockResolvedValue({ docs: [] }),
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CompanyRadarLinks } from '../CompanyRadarLinks';
import { getRelationshipsByCompanyId } from '@/lib/company-relationships';
import type { CompanyBlipRelationship } from '@/lib/types';

const mockGetRelationships = getRelationshipsByCompanyId as jest.MockedFunction<typeof getRelationshipsByCompanyId>;

describe('CompanyRadarLinks accessible names (UX-040)', () => {
  it('names the delete-link icon button with the resolved entry name', async () => {
    mockGetRelationships.mockResolvedValue([
      {
        id: 'link-1',
        companyId: 'comp-1',
        radarId: 'radar-1',
        radarEntryId: 7,
        relationshipType: 'User',
        notes: '',
        createdAt: 1,
        updatedAt: 1,
      } as CompanyBlipRelationship,
    ]);

    render(<CompanyRadarLinks companyId="comp-1" />);

    // No radar docs are loaded in this fixture, so the entry name resolves to
    // the "Unknown Technology" fallback — the label must still be contextual.
    expect(await screen.findByRole('button', { name: /delete radar link to unknown technology/i })).toBeInTheDocument();
  });
});
