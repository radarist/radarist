/** @jest-environment node */

export {};

jest.mock('server-only', () => ({}));

const mockAdminCreateCompany = jest.fn();
const mockAdminUpdateCompany = jest.fn();
const mockAdminGetCompanyById = jest.fn();
jest.mock('@/lib/companies-admin', () => ({
  adminCreateCompany: mockAdminCreateCompany,
  adminUpdateCompany: mockAdminUpdateCompany,
  adminGetCompanyById: mockAdminGetCompanyById,
}));

const { persistSourcedCompanyResearch } = require('../company-research-persistence');

// A cleared research result: website is sourced; size/stage were NOT sourced and
// are therefore absent from `facts` (abstained) and named in `unknowns`.
const baseResearch = {
  facts: { website: 'https://acme.example', description: 'A company.' },
  receipts: {
    website: [{ url: 'https://acme.example' }],
    description: [{ url: 'https://publisher.example/acme' }],
  },
  unknowns: ['size', 'stage'],
  contradictions: [],
  vendorCapabilities: [],
  missingEvidence: ['pricing'],
  sourcingComplete: false,
  citationsVerified: false,
};

describe('persistSourcedCompanyResearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminUpdateCompany.mockResolvedValue(undefined);
    mockAdminGetCompanyById.mockResolvedValue({ id: 'c1', name: 'Acme' });
    mockAdminCreateCompany.mockResolvedValue({ id: 'c2', name: 'Acme' });
  });

  it('writes a DRAFT only — never canonical Company fields — on update', async () => {
    await persistSourcedCompanyResearch({ kind: 'update', companyId: 'c1' }, { research: baseResearch });
    const updates = mockAdminUpdateCompany.mock.calls[0][1];
    // Canonical fields are NOT written by research — only the aiResearch draft is.
    expect('website' in updates).toBe(false);
    expect('description' in updates).toBe(false);
    expect('size' in updates).toBe(false);
    expect('stage' in updates).toBe(false);
    expect(Object.keys(updates)).toEqual(['aiResearch']);
    // Sourced proposed values are captured in the reviewable claim-value snapshot.
    expect(updates.aiResearch.data.claimValues).toEqual({
      website: 'https://acme.example',
      description: 'A company.',
    });
    expect(updates.aiResearch.data.sourcingComplete).toBe(false);
    expect(updates.aiResearch.data.citationsVerified).toBe(false);
    expect(updates.aiResearch.data.unknowns).toContain('size');
  });

  it('re-reads and returns the authoritative company after update', async () => {
    const result = await persistSourcedCompanyResearch({ kind: 'update', companyId: 'c1' }, { research: baseResearch });
    expect(mockAdminGetCompanyById).toHaveBeenCalledWith('c1');
    expect(result).toEqual({ id: 'c1', name: 'Acme' });
  });

  it('snapshots EVERY extracted claim value (sourcing enforced by the projection, not dropped here)', async () => {
    // Contract 1: an unsourced extracted fact must remain VISIBLE so the review
    // projection can BLOCK on it — it is never silently dropped at persistence time.
    // Only genuine claim fields enter; SWOT / socialLinks are not claim keys.
    await persistSourcedCompanyResearch(
      { kind: 'update', companyId: 'c1' },
      {
        research: {
          ...baseResearch,
          facts: {
            ...baseResearch.facts,
            size: 'large',
            stage: 'public',
            location: { city: 'Basel', country: 'Switzerland' },
            socialLinks: { linkedin: 'https://linkedin.com/company/acme' },
            // Deliberately hostile runtime input: SWOT is not a claim field.
            swot: { strengths: ['Generated claim'], weaknesses: [], opportunities: [], threats: [] },
          },
          receipts: {
            ...baseResearch.receipts,
            size: [{ url: 'not-a-url' }], // invalid receipt → size stays UNSOURCED (a blocker downstream)
            city: [{ url: 'https://publisher.example/basel' }],
          },
        } as never,
      }
    );

    const updates = mockAdminUpdateCompany.mock.calls[0][1];
    // Nothing canonical is written; only the draft.
    expect(Object.keys(updates)).toEqual(['aiResearch']);
    // EVERY extracted fact is snapshotted — including the unsourced `size` and the
    // unreceipted `stage`/`country` — so the projection can surface them as blockers.
    expect(updates.aiResearch.data.claimValues).toEqual({
      website: 'https://acme.example',
      description: 'A company.',
      size: 'large',
      stage: 'public',
      city: 'Basel',
      country: 'Switzerland',
    });
    // Non-claim runtime input never becomes a canonical write or a claim value.
    expect('socialLinks' in updates).toBe(false);
    expect('swot' in updates).toBe(false);
    expect('swot' in updates.aiResearch.data.claimValues).toBe(false);
  });

  it('creates a DRAFT — the seed defines canonical fields, research fills only aiResearch', async () => {
    const seed = {
      name: 'Acme',
      type: ['sme'],
      website: '',
      industry: [],
      location: { city: '', country: '' },
      status: 'Watching',
      tags: [],
      socialLinks: {},
      technologyStack: [],
    };
    const result = await persistSourcedCompanyResearch(
      { kind: 'create', seed },
      { research: baseResearch, competitors: ['Beta Corp'] }
    );
    const created = mockAdminCreateCompany.mock.calls[0][0];
    // Research does NOT overwrite the seed's canonical website — promotion would.
    expect(created.website).toBe('');
    // The proposed value lives in the reviewable draft instead.
    expect(created.aiResearch.data.claimValues.website).toBe('https://acme.example');
    expect(created.aiResearch.data.competitors).toEqual(['Beta Corp']);
    expect(result).toEqual({ id: 'c2', name: 'Acme' });
  });

  it('throws if the updated company cannot be re-read (never silently loses the write)', async () => {
    mockAdminGetCompanyById.mockResolvedValue(null);
    await expect(
      persistSourcedCompanyResearch({ kind: 'update', companyId: 'gone' }, { research: baseResearch })
    ).rejects.toThrow(/not found/i);
  });
});
