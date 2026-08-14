/**
 * Unit Tests for confirmPlacement AI Tool
 *
 * Tests human-in-the-loop confirmation for radar placements:
 * - Proposal generation (pending state)
 * - User approval handling
 * - User rejection handling
 * - User modification requests
 * - Invalid decision handling
 *
 * @jest-environment node
 * @phase Phase 0 Task 0.4.1
 */

import {
  executeConfirmPlacement,
} from '../ai/tools/technology-decoupled';

describe('confirmPlacement AI Tool (Task 0.4.1)', () => {
  describe('Proposal Generation', () => {
    it('should generate a pending proposal when no userDecision is provided', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'React is a mature, widely-adopted framework with excellent ecosystem support.',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.proposal).toEqual({
        technologyId: 'tech-123',
        technologyName: 'React',
        radarId: undefined,
        radarName: undefined,
        quadrant: 'Languages & Frameworks',
        ring: 'Adopt',
        rationale: 'React is a mature, widely-adopted framework with excellent ecosystem support.',
        evidencePoints: undefined,
        alternatives: undefined,
      });
      expect(result.message).toContain('Proposed Placement');
      expect(result.message).toContain('React');
      expect(result.message).toContain('Adopt');
    });

    it('should include evidence points in proposal message', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature and widely used',
        evidencePoints: [
          'Used by 5 major competitors',
          'Over 200k GitHub stars',
          'Strong community support',
        ],
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.message).toContain('Evidence');
      expect(result.message).toContain('Used by 5 major competitors');
      expect(result.message).toContain('Over 200k GitHub stars');
    });

    it('should include alternatives in proposal message', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        alternatives: [
          { ring: 'Trial', reason: 'Could be Trial if adoption is still limited' },
          { ring: 'Assess', reason: 'Too early for complex enterprise scenarios' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.message).toContain('Alternatives Considered');
      expect(result.message).toContain('Trial');
      expect(result.message).toContain('Assess');
    });

    it('should include radar name if provided', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        radarId: 'radar-abc',
        radarName: 'Frontend Technology Radar',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
      });

      expect(result.success).toBe(true);
      expect(result.proposal.radarId).toBe('radar-abc');
      expect(result.proposal.radarName).toBe('Frontend Technology Radar');
      expect(result.message).toContain('Frontend Technology Radar');
    });
  });

  describe('User Approval', () => {
    it('should handle "approved" decision', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'approved',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.userDecision).toBe('approved');
      expect(result.message).toContain('approved');
      expect(result.message).toContain('placeTechnologyOnRadar');
    });

    it('should handle "approve" (without d) decision', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'approve',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('should handle "yes" as approval', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'yes',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('should include user feedback with approval', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'approved',
        userFeedback: 'Good analysis!',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.userFeedback).toBe('Good analysis!');
    });
  });

  describe('User Rejection', () => {
    it('should handle "rejected" decision', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'rejected',
        userFeedback: 'We are not using React anymore',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
      expect(result.userDecision).toBe('rejected');
      expect(result.userFeedback).toBe('We are not using React anymore');
      expect(result.message).toContain('rejected');
      expect(result.message).toContain('We are not using React anymore');
    });

    it('should handle "reject" (without ed) decision', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'reject',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
    });

    it('should handle "no" as rejection', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'no',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
    });

    it('should handle rejection without feedback', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'rejected',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
      expect(result.message).not.toContain('Reason:');
    });
  });

  describe('User Modification Request', () => {
    it('should handle "modify" decision', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'modify',
        userFeedback: 'Should be in Trial ring instead',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('modified');
      expect(result.userDecision).toBe('modify');
      expect(result.userFeedback).toBe('Should be in Trial ring instead');
      expect(result.message).toContain('Modification requested');
      expect(result.message).toContain('Should be in Trial ring instead');
    });

    it('should handle "change" as modification request', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'change',
        userFeedback: 'Different quadrant please',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('modified');
    });
  });

  describe('Invalid Decisions', () => {
    it('should handle unknown decision with pending status', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'maybe',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('pending');
      expect(result.message).toContain('Unknown decision');
      expect(result.message).toContain('maybe');
    });

    it('should handle empty string decision as unknown', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: '',
      });

      // Empty string is falsy, so treated as no decision = pending proposal
      expect(result.status).toBe('pending');
    });
  });

  describe('Case Insensitivity', () => {
    it('should handle uppercase decisions', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'APPROVED',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('should handle mixed case decisions', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: 'ReJeCt',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
    });

    it('should handle decisions with whitespace', async () => {
      const result = await executeConfirmPlacement({
        technologyId: 'tech-123',
        technologyName: 'React',
        proposedQuadrant: 'Languages & Frameworks',
        proposedRing: 'Adopt',
        rationale: 'Mature framework',
        userDecision: '  approve  ',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });
  });
});
