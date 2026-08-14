/**
 * @jest-environment node
 */

jest.mock('@/lib/companies', () => ({
  createCompany: jest.fn(),
  getCompanyById: jest.fn(),
  updateCompany: jest.fn(),
}));

import {
  resolveCompanyCreateOutcome,
  resolveCompanyUpdateOutcome,
  type CompanyCreateInput,
} from '@/lib/company-mutation-outcome';
import { createCompany, getCompanyById, updateCompany } from '@/lib/companies';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import type { Company } from '@/lib/types';

const company = {
  id: 'company-1',
  slug: 'company-1',
  name: 'Acme',
  description: '',
  website: '',
  logo: '',
  type: ['startup'],
  industry: [],
  industryCustom: [],
  size: 'small',
  stage: 'seed',
  location: { city: '', country: '' },
  status: 'Watching',
  tags: [],
  socialLinks: {},
  technologyStack: [],
  documents: [],
  createdAt: 1,
  updatedAt: 1,
} as Company;

const mockedCreateCompany = jest.mocked(createCompany);
const mockedGetCompanyById = jest.mocked(getCompanyById);
const mockedUpdateCompany = jest.mocked(updateCompany);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('company mutation outcome adapter', () => {
  it('returns the acknowledged handoff as saved and queued', async () => {
    mockedUpdateCompany.mockResolvedValue(undefined);

    await expect(resolveCompanyUpdateOutcome(company, { name: 'Acme Updated' })).resolves.toEqual(
      expect.objectContaining({
        status: 'saved-and-queued',
        entityId: company.id,
        entity: expect.objectContaining({ name: 'Acme Updated' }),
      })
    );
    expect(mockedGetCompanyById).not.toHaveBeenCalled();
  });

  it('re-reads authoritative company state after an update handoff failure', async () => {
    const committed = { ...company, name: 'Committed' };
    mockedUpdateCompany.mockRejectedValue(
      new EntitySyncDispatchError('company', company.id, 'update', new Error('queue unavailable'))
    );
    mockedGetCompanyById.mockResolvedValue(committed);

    await expect(resolveCompanyUpdateOutcome(company, { name: 'Committed' })).resolves.toEqual(
      expect.objectContaining({ status: 'saved-locally', entity: committed })
    );
  });

  it('keeps pre-commit create rejection distinct from a committed save', async () => {
    const rejected = new Error('permission denied');
    mockedCreateCompany.mockRejectedValue(rejected);
    const createInput = {
      name: company.name,
      description: company.description,
      website: company.website,
      logo: company.logo,
      type: company.type,
      industry: company.industry,
      industryCustom: company.industryCustom,
      size: company.size,
      stage: company.stage,
      location: company.location,
      status: company.status,
      tags: company.tags,
      socialLinks: company.socialLinks,
      technologyStack: company.technologyStack,
      documents: company.documents,
    } satisfies CompanyCreateInput;

    await expect(resolveCompanyCreateOutcome(createInput)).resolves.toEqual(
      expect.objectContaining({ status: 'rejected', error: rejected })
    );
    expect(mockedGetCompanyById).not.toHaveBeenCalled();
  });
});
