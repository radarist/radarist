import { shouldMaterializeAssertion } from '../assertions';
import {
  machineRelationAutoApprovalThreshold,
  MAX_MACHINE_RELIABILITY_ADJUSTMENT,
} from '../materialization-policy';

describe('machine relation auto-approval policy', () => {
  it('guarantees materialization at the auto-approval floor under the maximum reliability penalty', () => {
    const threshold = machineRelationAutoApprovalThreshold(true);
    expect(
      shouldMaterializeAssertion(threshold, 'agent:linker', {
        reliabilityBonus: -MAX_MACHINE_RELIABILITY_ADJUSTMENT,
        claimStatus: 'proposed',
      })
    ).toBe(true);
  });

  it('keeps the point below the floor in triage under the maximum reliability penalty', () => {
    const threshold = machineRelationAutoApprovalThreshold(true);
    expect(
      shouldMaterializeAssertion(threshold - 1, 'agent:linker', {
        reliabilityBonus: -MAX_MACHINE_RELIABILITY_ADJUSTMENT,
        claimStatus: 'proposed',
      })
    ).toBe(false);
  });

  it('uses the normal graph floor when reliability consumption is disabled', () => {
    expect(machineRelationAutoApprovalThreshold(false)).toBe(75);
    expect(machineRelationAutoApprovalThreshold(true)).toBe(85);
  });
});
