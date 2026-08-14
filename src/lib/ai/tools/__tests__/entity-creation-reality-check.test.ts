/**
 * @jest-environment node
 */

// ============================================================================
// Mocks (MUST be before imports)
// ============================================================================

// Source modules migrated client→admin: entity-creation.ts now calls
// adminCreateCompany (companies-admin) and adminCreateTechnology
// (technology-admin); technology-decoupled.ts calls adminCreateTechnology too.
jest.mock('@/lib/companies-admin', () => ({
  adminCreateCompany: jest.fn(),
  adminUpdateCompany: jest.fn(),
  adminGetCompanies: jest.fn(),
}));

jest.mock('@/lib/technology-admin', () => ({
  adminCreateTechnology: jest.fn(),
  adminUpdateTechnology: jest.fn(),
  adminGetTechnologies: jest.fn(),
  adminGetTechnologyById: jest.fn(),
}));

jest.mock('@/lib/entity-reality-check', () => ({
  verifyEntityReality: jest.fn(),
}));

jest.mock('@/lib/scout-url-verifier', () => ({
  verifyUrlsReachable: jest.fn(),
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/ai/flows/research-company-comprehensive', () => ({
  researchCompanyComprehensive: jest.fn().mockResolvedValue({}),
}));

jest.mock('@/lib/events/data-refresh', () => ({ emitDataRefresh: jest.fn() }));

import { executeCreateCompany, executeCreateTechnology } from '../entity-creation';
import { verifyEntityReality } from '@/lib/entity-reality-check';
import { verifyUrlsReachable } from '@/lib/scout-url-verifier';
import { adminCreateCompany as createCompany } from '@/lib/companies-admin';
import { adminCreateTechnology as createDecoupledTech } from '@/lib/technology-admin';

const mockVerifyReality = verifyEntityReality as jest.MockedFunction<typeof verifyEntityReality>;
const mockVerifyUrls = verifyUrlsReachable as jest.MockedFunction<typeof verifyUrlsReachable>;
const mockCreateCompany = createCompany as jest.MockedFunction<typeof createCompany>;
const mockCreateTech = createDecoupledTech as jest.MockedFunction<typeof createDecoupledTech>;

// File-level env gate — entity-creation.ts:723 + :841 and the parallel
// technology-decoupled.ts checks only invoke verifyEntityReality when
// DEFENSE_MINISTER_ENABLED === 'true' (defense in depth added in commit
// 99c47f37). All three describes below assert on that path.
// Use beforeEach/afterEach (not beforeAll) so the env doesn't leak across
// files in the same Jest worker.
beforeEach(() => {
  process.env.DEFENSE_MINISTER_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.DEFENSE_MINISTER_ENABLED;
});

describe('executeCreateCompany — reality check gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateCompany.mockResolvedValue({ id: 'c-1', name: 'Test' } as unknown as Awaited<
      ReturnType<typeof createCompany>
    >);
  });

  it('blocks creation when reality check fails and no website is provided', async () => {
    mockVerifyReality.mockResolvedValue({
      ok: false,
      reason: 'no-name-match',
      summary: 'unrelated text',
    });
    const result = await executeCreateCompany({
      name: 'QuantumFlavor Labs',
      description: 'fake',
    });
    expect(result.success).toBe(false);
    expect(mockCreateCompany).not.toHaveBeenCalled();
    expect((result.data as Record<string, unknown>)?.realityCheckFailed).toBe(true);
  });

  it('bypasses reality check when a website is provided and resolves', async () => {
    mockVerifyUrls.mockResolvedValue({ ok: true });
    const result = await executeCreateCompany({
      name: 'Anthropic',
      description: 'real',
      website: 'https://anthropic.com',
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockCreateCompany).toHaveBeenCalled();
  });

  it('bypasses reality check when skipRealityCheck is true', async () => {
    const result = await executeCreateCompany({
      name: 'Internal Project',
      description: 'skip',
      skipRealityCheck: true,
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockVerifyUrls).not.toHaveBeenCalled();
    expect(mockCreateCompany).toHaveBeenCalled();
  });

  it('proceeds when reality check passes', async () => {
    mockVerifyReality.mockResolvedValue({
      ok: true,
      reason: 'verified',
      evidenceText: 'Anthropic is an AI safety company.',
    });
    const result = await executeCreateCompany({ name: 'Anthropic', description: 'real' });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).toHaveBeenCalledWith('Anthropic');
    expect(mockCreateCompany).toHaveBeenCalled();
  });
});

describe('executeCreateTechnology — reality check gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTech.mockResolvedValue({ id: 't-1', name: 'Test' } as unknown as Awaited<
      ReturnType<typeof createDecoupledTech>
    >);
  });

  it('blocks creation when reality check fails and no URL is provided', async () => {
    mockVerifyReality.mockResolvedValue({
      ok: false,
      reason: 'no-results',
      summary: '',
    });
    const result = await executeCreateTechnology({
      name: 'NeverWasFramework',
      description: 'fake',
    });
    expect(result.success).toBe(false);
    expect(mockCreateTech).not.toHaveBeenCalled();
    expect((result.data as Record<string, unknown> | undefined)?.realityCheckFailed).toBe(true);
  });

  it('bypasses reality check when websiteUrl resolves', async () => {
    mockVerifyUrls.mockResolvedValue({ ok: true });
    const result = await executeCreateTechnology({
      name: 'React',
      description: 'real',
      websiteUrl: 'https://react.dev',
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockCreateTech).toHaveBeenCalled();
  });

  it('bypasses reality check when githubUrl resolves (websiteUrl absent)', async () => {
    mockVerifyUrls.mockResolvedValue({ ok: true });
    const result = await executeCreateTechnology({
      name: 'SomeLib',
      description: 'real',
      githubUrl: 'https://github.com/org/somelib',
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockCreateTech).toHaveBeenCalled();
  });

  it('bypasses reality check when skipRealityCheck is true', async () => {
    const result = await executeCreateTechnology({
      name: 'InternalDSL',
      description: 'skip',
      skipRealityCheck: true,
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockVerifyUrls).not.toHaveBeenCalled();
    expect(mockCreateTech).toHaveBeenCalled();
  });
});

describe('executeCreateDecoupledTechnology — reality check gate', () => {
  // The decoupled tool path mirrors executeCreateTechnology but lives in
  // a separate file (technology-decoupled.ts). The AI often picks this
  // path; without the gate, hallucinated technologies bypass the check.
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTech.mockResolvedValue({
      id: 'td-1',
      name: 'Test',
      slug: 'test',
    } as unknown as Awaited<ReturnType<typeof createDecoupledTech>>);
  });

  it('blocks creation when reality check fails and no URL is provided', async () => {
    mockVerifyReality.mockResolvedValue({
      ok: false,
      reason: 'no-results',
      summary: '',
    });
    const { executeCreateDecoupledTechnology } = await import('../technology-decoupled');
    const result = await executeCreateDecoupledTechnology({
      name: 'NeverWasFramework2',
      description: 'fake',
    });
    expect(result.success).toBe(false);
    expect(mockCreateTech).not.toHaveBeenCalled();
    expect((result.data as Record<string, unknown> | undefined)?.realityCheckFailed).toBe(true);
  });

  it('bypasses reality check when websiteUrl resolves', async () => {
    mockVerifyUrls.mockResolvedValue({ ok: true });
    const { executeCreateDecoupledTechnology } = await import('../technology-decoupled');
    const result = await executeCreateDecoupledTechnology({
      name: 'React',
      description: 'real',
      websiteUrl: 'https://react.dev',
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockCreateTech).toHaveBeenCalled();
  });

  it('bypasses reality check when githubUrl resolves (websiteUrl absent)', async () => {
    mockVerifyUrls.mockResolvedValue({ ok: true });
    const { executeCreateDecoupledTechnology } = await import('../technology-decoupled');
    const result = await executeCreateDecoupledTechnology({
      name: 'SomeLib',
      description: 'real',
      githubUrl: 'https://github.com/org/somelib',
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockCreateTech).toHaveBeenCalled();
  });

  it('bypasses reality check when skipRealityCheck is true', async () => {
    const { executeCreateDecoupledTechnology } = await import('../technology-decoupled');
    const result = await executeCreateDecoupledTechnology({
      name: 'InternalDSL',
      description: 'skip',
      skipRealityCheck: true,
    });
    expect(result.success).toBe(true);
    expect(mockVerifyReality).not.toHaveBeenCalled();
    expect(mockVerifyUrls).not.toHaveBeenCalled();
    expect(mockCreateTech).toHaveBeenCalled();
  });
});
