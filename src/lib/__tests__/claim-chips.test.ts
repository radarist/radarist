import { type ClaimEvidenceLike, computeCorroboration, deriveClaimChip } from '../claim-chips';

describe('claim-chips', () => {
  describe('computeCorroboration', () => {
    it('counts distinct sources with key precedence url > documentId > signalId > id', () => {
      const evidence: ClaimEvidenceLike[] = [
        { sourceUrl: 'https://example.com', sourceType: 'web' },
        { sourceUrl: 'https://example.com', sourceType: 'web' }, // duplicate URL → 1 distinct
        { documentId: 'doc-1', sourceType: 'document' },
        { signalId: 'sig-1', sourceType: 'signal' },
        { id: 'item-1', sourceType: 'other' },
      ];

      const result = computeCorroboration(evidence);
      expect(result.independentSourceCount).toBe(4);
      expect(result.level).toBe('corroborated');
    });

    it('excludes user_assertion, edge_annotation, and first-party entity_field evidence', () => {
      const evidence: ClaimEvidenceLike[] = [
        { sourceUrl: 'https://example.com', sourceType: 'user_assertion' },
        { documentId: 'doc-1', sourceType: 'edge_annotation' },
        {
          id: 'entity-ref',
          sourceType: 'entity_field',
          entityId: 'tech-1',
          entityType: 'technology',
          entityField: 'description',
        },
      ];

      const result = computeCorroboration(evidence);
      expect(result.independentSourceCount).toBe(0);
      expect(result.level).toBe('unverified');
    });

    it('maps 0→unverified, 1→single, ≥2→corroborated', () => {
      // 0 distinct
      expect(computeCorroboration([]).level).toBe('unverified');
      expect(
        computeCorroboration([
          { sourceType: 'user_assertion' },
          { sourceType: 'edge_annotation' },
          { sourceType: 'entity_field', entityId: 'tech-1' },
        ]).level
      ).toBe('unverified');

      // 1 distinct
      expect(computeCorroboration([{ sourceUrl: 'https://example.com', sourceType: 'web' }]).level).toBe('single');

      // 2+ distinct
      expect(
        computeCorroboration([
          { sourceUrl: 'https://example.com', sourceType: 'web' },
          { documentId: 'doc-1', sourceType: 'document' },
        ]).level
      ).toBe('corroborated');
      expect(
        computeCorroboration([
          { sourceUrl: 'https://example.com', sourceType: 'web' },
          { documentId: 'doc-1', sourceType: 'document' },
          { signalId: 'sig-1', sourceType: 'signal' },
        ]).level
      ).toBe('corroborated');
    });

    it('handles items with no key fields (falls back through sourceUrl > documentId > signalId > id)', () => {
      // Items with no sourceUrl, documentId, signalId, or id → undefined key → skip from counting
      const evidence: ClaimEvidenceLike[] = [
        { sourceUrl: 'https://example.com', sourceType: 'web' },
        { sourceType: 'document' }, // no key fields → skipped
        { sourceType: 'signal' }, // no key fields → skipped
      ];

      const result = computeCorroboration(evidence);
      expect(result.independentSourceCount).toBe(1);
      expect(result.level).toBe('single');
    });

    it('counts independentSourceCount always, regardless of sourceType exclusions', () => {
      const evidence: ClaimEvidenceLike[] = [
        { sourceUrl: 'https://example.com', sourceType: 'web' },
        { sourceUrl: 'https://example.com', sourceType: 'user_assertion' },
        { documentId: 'doc-1', sourceType: 'edge_annotation' },
      ];

      const result = computeCorroboration(evidence);
      // Only web counts (user_assertion and edge_annotation excluded)
      expect(result.independentSourceCount).toBe(1);
      expect(result.level).toBe('single');
    });

    // GRAPH-070 — corroboration is keyed on canonical publisher identity, so a
    // provenance layer handing us aliasing URLs cannot inflate the derived
    // `effectiveConfidence` that the B0/C3 contract builds on this count.
    describe('canonical publisher identity keying (GRAPH-070)', () => {
      const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';

      it('counts two unresolved grounding redirects as ONE source, not two', () => {
        const result = computeCorroboration([
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}AUZIYQaaa` },
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}AUZIYQbbb` },
        ]);

        expect(result.independentSourceCount).toBe(1);
        expect(result.level).toBe('single');
      });

      it('collapses many unresolved redirects to one bucket, never reaching corroborated', () => {
        const result = computeCorroboration([
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}a` },
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}b` },
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}c` },
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}d` },
        ]);

        expect(result.independentSourceCount).toBe(1);
        expect(result.level).toBe('single');
      });

      it('treats http/https and utm-tagged variants of one publisher as one source', () => {
        const result = computeCorroboration([
          { sourceType: 'web_ref', sourceUrl: 'http://www.example.com/a?utm_source=x' },
          { sourceType: 'web_ref', sourceUrl: 'https://example.com/a' },
        ]);

        expect(result.independentSourceCount).toBe(1);
        expect(result.level).toBe('single');
      });

      it('still counts two genuinely distinct publishers as corroborated', () => {
        const result = computeCorroboration([
          { sourceType: 'web_ref', sourceUrl: 'https://a.com/x' },
          { sourceType: 'web_ref', sourceUrl: 'https://b.com/y' },
        ]);

        expect(result.independentSourceCount).toBe(2);
        expect(result.level).toBe('corroborated');
      });

      it('counts a resolved publisher alongside an unresolved redirect as two sources', () => {
        const result = computeCorroboration([
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}AUZIYQaaa` },
          { sourceType: 'web_ref', sourceUrl: 'https://publisher.com/article' },
        ]);

        expect(result.independentSourceCount).toBe(2);
        expect(result.level).toBe('corroborated');
      });

      it('keeps unparseable sourceUrl values distinct from each other', () => {
        // Not http(s) → no canonical identity. They stay separate rather than
        // collapsing into one bucket, which would UNDER-count real sources.
        const result = computeCorroboration([
          { sourceType: 'web_ref', sourceUrl: 'not a url' },
          { sourceType: 'web_ref', sourceUrl: 'also not a url' },
        ]);

        expect(result.independentSourceCount).toBe(2);
      });

      it('is idempotent — recomputing over the same evidence yields the same count', () => {
        const evidence: ClaimEvidenceLike[] = [
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}a` },
          { sourceType: 'web_ref', sourceUrl: `${REDIRECT}b` },
          { sourceType: 'web_ref', sourceUrl: 'https://publisher.com/article' },
        ];

        expect(computeCorroboration(evidence)).toEqual(computeCorroboration(evidence));
        expect(computeCorroboration(evidence).independentSourceCount).toBe(2);
      });
    });
  });

  describe('deriveClaimChip', () => {
    it('curated/user-asserted claims chip as curated regardless of evidence count', () => {
      const claim1 = {
        relationId: 'rel-1',
        id: 'claim-1',
        statement: 'Test statement',
        asserterType: 'user',
        status: 'proposed',
      };
      const evidence: ClaimEvidenceLike[] = []; // no evidence

      const chip1 = deriveClaimChip(claim1, evidence);
      expect(chip1.kind).toBe('curated');
      expect(chip1.independentSourceCount).toBe(0);

      const claim2 = {
        relationId: 'rel-2',
        id: 'claim-2',
        statement: 'Another statement',
        asserterType: 'bot',
        status: 'curated',
      };

      const chip2 = deriveClaimChip(claim2, evidence);
      expect(chip2.kind).toBe('curated');
      expect(chip2.independentSourceCount).toBe(0);
    });

    it('non-curated claims use corroboration level as kind', () => {
      const evidence0: ClaimEvidenceLike[] = [];
      const evidence1: ClaimEvidenceLike[] = [{ sourceUrl: 'https://example.com', sourceType: 'web' }];
      const evidence2: ClaimEvidenceLike[] = [
        { sourceUrl: 'https://example.com', sourceType: 'web' },
        { documentId: 'doc-1', sourceType: 'document' },
      ];

      const claim = {
        relationId: 'rel-1',
        id: 'claim-1',
        statement: 'Non-curated claim',
        asserterType: 'bot',
        status: 'proposed',
      };

      const chip0 = deriveClaimChip(claim, evidence0);
      expect(chip0.kind).toBe('unverified');

      const chip1 = deriveClaimChip(claim, evidence1);
      expect(chip1.kind).toBe('single');

      const chip2 = deriveClaimChip(claim, evidence2);
      expect(chip2.kind).toBe('corroborated');
    });

    it('populates relationId, statement, and independentSourceCount correctly', () => {
      const claim = {
        relationId: 'rel-123',
        id: 'fallback-id',
        statement: 'Test claim statement',
        asserterType: 'bot',
        status: 'proposed',
      };
      const evidence: ClaimEvidenceLike[] = [
        { sourceUrl: 'https://example.com', sourceType: 'web' },
        { documentId: 'doc-1', sourceType: 'document' },
      ];

      const chip = deriveClaimChip(claim, evidence);
      expect(chip.relationId).toBe('rel-123');
      expect(chip.statement).toBe('Test claim statement');
      expect(chip.independentSourceCount).toBe(2);
    });

    it('falls back to claim.id when relationId is missing', () => {
      const claim = {
        id: 'claim-id-123',
        statement: 'Statement',
        asserterType: 'user',
        status: 'proposed',
      };

      const chip = deriveClaimChip(claim, []);
      expect(chip.relationId).toBe('claim-id-123');
    });

    it('uses empty string for relationId when both relationId and id are missing', () => {
      const claim = {
        statement: 'Statement',
        asserterType: 'bot',
        status: 'proposed',
      };

      const chip = deriveClaimChip(claim, []);
      expect(chip.relationId).toBe('');
    });

    it('uses empty string for statement when statement is missing', () => {
      const claim = {
        relationId: 'rel-1',
        asserterType: 'bot',
        status: 'proposed',
      };

      const chip = deriveClaimChip(claim, []);
      expect(chip.statement).toBe('');
    });

    it('curated status wins over non-curated asserterType', () => {
      const claim = {
        relationId: 'rel-1',
        statement: 'Curated statement',
        asserterType: 'bot',
        status: 'curated',
      };
      const evidence: ClaimEvidenceLike[] = [];

      const chip = deriveClaimChip(claim, evidence);
      expect(chip.kind).toBe('curated');
    });

    it('user asserterType wins over non-curated status', () => {
      const claim = {
        relationId: 'rel-1',
        statement: 'User statement',
        asserterType: 'user',
        status: 'proposed',
      };
      const evidence: ClaimEvidenceLike[] = [];

      const chip = deriveClaimChip(claim, evidence);
      expect(chip.kind).toBe('curated');
    });
  });
});
