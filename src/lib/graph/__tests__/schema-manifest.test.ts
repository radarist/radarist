import {
  parseSchemaObjectName,
  summarizeSchemaResults,
  expectedSchemaObjects,
  CONSTRAINTS,
  INDEXES,
  CONTEXT_SCHEMA,
  VECTOR_INDEXES,
  FULLTEXT_INDEXES,
} from '../schema-manifest';

describe('parseSchemaObjectName', () => {
  it('extracts a constraint name', () => {
    expect(
      parseSchemaObjectName('CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE')
    ).toBe('entity_id');
  });

  it('extracts a plain index name', () => {
    expect(parseSchemaObjectName('CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.entityType)')).toBe(
      'entity_type'
    );
  });

  it('extracts a VECTOR index name (two-word keyword)', () => {
    expect(
      parseSchemaObjectName('CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS\n FOR (c:Chunk) ON (c.embedding)')
    ).toBe('chunk_embedding');
  });

  it('extracts a FULLTEXT index name', () => {
    expect(
      parseSchemaObjectName('CREATE FULLTEXT INDEX entity_name_idx IF NOT EXISTS FOR (e:Entity) ON EACH [e.name]')
    ).toBe('entity_name_idx');
  });

  it('returns null for a DROP statement (not a create)', () => {
    expect(parseSchemaObjectName('DROP CONSTRAINT claim_id IF EXISTS')).toBeNull();
  });
});

describe('summarizeSchemaResults', () => {
  it('reports all-ok when every statement succeeded', () => {
    const s = summarizeSchemaResults([
      { label: 'a', ok: true },
      { label: 'b', ok: true },
    ]);
    expect(s).toEqual({ total: 2, ok: 2, failed: 0, failures: [] });
  });

  it('collects every failed label (does not swallow failures)', () => {
    const s = summarizeSchemaResults([
      { label: 'entity_id', ok: true },
      { label: 'chunk_embedding', ok: false },
      { label: 'company_id', ok: false },
    ]);
    expect(s.failed).toBe(2);
    expect(s.failures).toEqual(['chunk_embedding', 'company_id']);
  });
});

describe('expectedSchemaObjects', () => {
  it('includes the chunk vector index (the CRIT-2 unbrick target)', () => {
    expect(expectedSchemaObjects().vectorIndexes).toContain('chunk_embedding');
  });

  it('includes all three entity vector indexes (ported from schema.cypher)', () => {
    const v = expectedSchemaObjects().vectorIndexes;
    expect(v).toEqual(expect.arrayContaining(['technology_embedding', 'company_embedding', 'signal_embedding']));
  });

  it('includes core entity uniqueness constraints', () => {
    expect(expectedSchemaObjects().constraints).toContain('entity_id');
  });

  // BONUS-fulltext: ad-hoc / NL-generated Cypher may call
  // db.index.fulltext.queryNodes("entity_name_idx", …) — the manifest must
  // actually create that index or such readers throw ProcedureCallFailed.
  it('declares the entity_name_idx FULLTEXT index that fulltext name lookup depends on', () => {
    expect(FULLTEXT_INDEXES).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /CREATE FULLTEXT INDEX entity_name_idx IF NOT EXISTS FOR \(e:Entity\) ON EACH \[e\.name\]/
        ),
      ])
    );
  });

  it('exposes fulltext indexes in expectedSchemaObjects() so graph:health can diff them', () => {
    expect(expectedSchemaObjects().fulltextIndexes).toContain('entity_name_idx');
  });

  // Evidence accrual (idempotent MERGE on assertionId+sourceKey): every
  // addEvidenceToAssertion write hits this composite key, so it needs a
  // matching index or every accrual write becomes a full label scan.
  it('declares the evidence_assertion_sourcekey composite index for evidence accrual', () => {
    expect(INDEXES).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /CREATE INDEX evidence_assertion_sourcekey IF NOT EXISTS FOR \(e:Evidence\) ON \(e\.assertionId, e\.sourceKey\)/
        ),
      ])
    );
  });

  it('exposes evidence_assertion_sourcekey in expectedSchemaObjects().indexes', () => {
    expect(expectedSchemaObjects().indexes).toContain('evidence_assertion_sourcekey');
  });

  it('declares and exposes Community-compatible endpoint indexes for both supported labels', () => {
    expect(INDEXES).toEqual(
      expect.arrayContaining([
        'CREATE INDEX assertion_subject IF NOT EXISTS FOR (a:Assertion) ON (a.subjectId)',
        'CREATE INDEX assertion_object IF NOT EXISTS FOR (a:Assertion) ON (a.objectId)',
        'CREATE INDEX legacy_claim_subject IF NOT EXISTS FOR (c:Claim) ON (c.subjectId)',
        'CREATE INDEX legacy_claim_object IF NOT EXISTS FOR (c:Claim) ON (c.objectId)',
      ])
    );
    expect(expectedSchemaObjects().indexes).toEqual(
      expect.arrayContaining([
        'assertion_subject',
        'assertion_object',
        'legacy_claim_subject',
        'legacy_claim_object',
      ])
    );
    expect(INDEXES).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/FOR \([ac]:(?:Assertion|Claim)\) ON \([ac]\.subjectId,\s*[ac]\.objectId\)/),
      ])
    );
  });

  // Graph learning-loop MERGE keys: interest-profile / relation-assertion-sync /
  // asserter-reliability / community-reports each MERGE on these. Without a
  // constraint a fresh clone MERGEs them unconstrained until a manual migration.
  it('declares the graph learning-loop MERGE-key uniqueness constraints', () => {
    expect(expectedSchemaObjects().constraints).toEqual(
      expect.arrayContaining([
        'ip_userId',
        'assertion_relationId',
        'asserter_reliability_asserter',
        'community_report_id',
      ])
    );
  });

  it('indexes ip.updatedAt for the discovery-loop learning store (manifest parity with the migration)', () => {
    expect(expectedSchemaObjects().indexes).toContain('ip_updatedAt');
  });

  it('declares preference identity and replay-receipt uniqueness constraints', () => {
    expect(expectedSchemaObjects().constraints).toEqual(
      expect.arrayContaining(['user_preference_user_topic', 'preference_engagement_receipt_id'])
    );
    expect(CONTEXT_SCHEMA).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /CREATE CONSTRAINT user_preference_user_topic IF NOT EXISTS FOR \(up:UserPreference\) REQUIRE \(up\.userId, up\.topic\) IS UNIQUE/
        ),
        expect.stringMatching(
          /CREATE CONSTRAINT preference_engagement_receipt_id IF NOT EXISTS FOR \(receipt:PreferenceEngagementReceipt\) REQUIRE receipt\.id IS UNIQUE/
        ),
      ])
    );
  });

  it('declares mission Observation identity uniqueness', () => {
    expect(expectedSchemaObjects().constraints).toContain('observation_id');
    expect(CONTEXT_SCHEMA).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /CREATE CONSTRAINT observation_id IF NOT EXISTS FOR \(n:Observation\) REQUIRE n\.id IS UNIQUE/
        ),
      ])
    );
  });

  it('does not reuse the deprecated claim_* names for runtime assertion indexes', () => {
    // The drop/create collision fix: runtime assertion schema must NOT be named claim_*
    // (init drops claim_*; recreating them under the same name is the bug).
    const all = [...CONSTRAINTS, ...VECTOR_INDEXES];
    const claimNamed = all.filter((s) => /\b(CONSTRAINT|INDEX)\s+claim_/i.test(s));
    expect(claimNamed).toEqual([]);
  });
});
