import { supportedEntityTypeSchema, proposedEntitySchema, generateProposedEntityKey } from '../proposed-entity';

describe('supportedEntityTypeSchema', () => {
  it('allows the five growth dimensions', () => {
    for (const t of ['technology', 'company', 'useCase', 'painPoint', 'prototype']) {
      expect(supportedEntityTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects out-of-allow-list entity types', () => {
    for (const t of ['strategy', 'initiative', 'orgUnit', 'document', 'report', 'concept']) {
      expect(supportedEntityTypeSchema.safeParse(t).success).toBe(false);
    }
  });
});

describe('proposedEntitySchema', () => {
  const base = {
    id: 'k',
    entityType: 'company',
    name: 'Acme AI',
    confidence: 80,
    createdAt: 1,
    updatedAt: 1,
  };

  it('parses a minimal proposed entity (defaults fill data/evidence/status)', () => {
    const parsed = proposedEntitySchema.parse(base);
    expect(parsed.status).toBe('pending');
    expect(parsed.data).toEqual({});
    expect(parsed.evidence).toEqual({ metrics: [], findings: [] });
  });

  it('rejects a proposed entity with a disallowed entityType', () => {
    expect(proposedEntitySchema.safeParse({ ...base, entityType: 'strategy' }).success).toBe(false);
  });
});

describe('generateProposedEntityKey', () => {
  it('is a 32-char hex string', () => {
    expect(generateProposedEntityKey('company', 'acme-ai', 'acme.com')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same inputs', () => {
    expect(generateProposedEntityKey('company', 'acme-ai', 'acme.com')).toBe(
      generateProposedEntityKey('company', 'acme-ai', 'acme.com')
    );
  });

  it('is distinct when primaryDomain differs', () => {
    expect(generateProposedEntityKey('company', 'acme-ai', 'acme.com')).not.toBe(
      generateProposedEntityKey('company', 'acme-ai', 'other.com')
    );
  });
});
