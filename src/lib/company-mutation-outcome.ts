import { createCompany, getCompanyById, updateCompany } from '@/lib/companies';
import { resolveEntityMutationOutcome, type EntityMutationOutcome } from '@/lib/entity-mutation-outcome';
import type { Company } from '@/lib/types';

export type CompanyMutationOutcome = EntityMutationOutcome<Company>;
export type CompanyCreateInput = Parameters<typeof createCompany>[0];
export type CompanyUpdateInput = Parameters<typeof updateCompany>[1];

export function resolveCompanyCreateOutcome(input: CompanyCreateInput): Promise<CompanyMutationOutcome> {
  return resolveEntityMutationOutcome({
    entityType: 'company',
    operation: 'create',
    mutate: () => createCompany(input),
    readAuthoritative: getCompanyById,
  });
}

/**
 * Preserve the caller's current snapshot for the acknowledged fast path. A
 * failed graph handoff is always resolved from Firestore by the shared truth
 * contract, so the degraded path never relies on this optimistic merge.
 */
export function resolveCompanyUpdateOutcome(
  current: Company,
  updates: CompanyUpdateInput
): Promise<CompanyMutationOutcome> {
  return resolveEntityMutationOutcome({
    entityType: 'company',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updateCompany(current.id, updates);
      return {
        ...current,
        ...updates,
        id: current.id,
        updatedAt: Date.now(),
      } as Company;
    },
    readAuthoritative: getCompanyById,
  });
}
