/**
 * @jest-environment node
 *
 * GRAPH-064 — the mention-trust derivation. A mention edge's worth is capped by
 * the text it matched in, so these tests pin the classification of every source
 * shape the workspace can produce.
 */

import {
  deriveDocumentContentProvenance,
  deriveMentionSourceReviewState,
  deriveMentionTrust,
  deriveMentionTrustForDocument,
  REVIEWED_MENTION_CONFIDENCE,
  UNREVIEWED_MENTION_CONFIDENCE,
} from '../mention-trust';

describe('deriveDocumentContentProvenance', () => {
  it('classifies a build-mission artifact as machine-generated', () => {
    expect(deriveDocumentContentProvenance({ uploadedBy: 'build-mission', type: 'markdown' })).toBe(
      'machine-generated'
    );
    expect(deriveDocumentContentProvenance({ sourceRunId: 'run-1', type: 'markdown' })).toBe('machine-generated');
    expect(deriveDocumentContentProvenance({ sourceMissionId: 'mission-1' })).toBe('machine-generated');
  });

  // Deep-research drafts are created as `type: 'markdown'` with a
  // `deep-research` tag (see deep-research-document-admin.ts) — the tag is the
  // only marker, so it has to be load-bearing.
  it('classifies a deep-research draft as machine-generated via its tag', () => {
    expect(deriveDocumentContentProvenance({ type: 'markdown', tags: ['quantum', 'deep-research'] })).toBe(
      'machine-generated'
    );
    expect(deriveDocumentContentProvenance({ type: 'markdown', tags: ['Deep-Research'] })).toBe('machine-generated');
    expect(deriveDocumentContentProvenance({ type: 'deep-research' })).toBe('machine-generated');
  });

  // A deep-research job writes canonical storage once it finishes, and a
  // build-mission report is a genuine file. Neither may be reclassified as
  // external just because it acquired a storage path.
  it('keeps machine provenance even once the document has stored content', () => {
    expect(
      deriveDocumentContentProvenance({
        type: 'markdown',
        tags: ['deep-research'],
        storageUrl: 'documents/deep-research-1.md',
      })
    ).toBe('machine-generated');
    expect(
      deriveDocumentContentProvenance({
        uploadedBy: 'build-mission',
        storageUrl: 'documents/report.md',
        originalUrl: 'https://example.com/report',
      })
    ).toBe('machine-generated');
  });

  it('classifies third-party content as external', () => {
    expect(deriveDocumentContentProvenance({ type: 'pdf', uploadedBy: 'user-1' })).toBe('external');
    expect(deriveDocumentContentProvenance({ type: 'url', originalUrl: 'https://example.com' })).toBe('external');
    expect(deriveDocumentContentProvenance({ type: 'transcript' })).toBe('external');
    expect(deriveDocumentContentProvenance({ type: 'markdown', storageUrl: 'documents/notes.md' })).toBe('external');
    expect(deriveDocumentContentProvenance({ type: 'text', domain: 'techcrunch.com' })).toBe('external');
  });

  it('fails closed to unknown for an unclassifiable or absent document', () => {
    expect(deriveDocumentContentProvenance(null)).toBe('unknown');
    expect(deriveDocumentContentProvenance(undefined)).toBe('unknown');
    expect(deriveDocumentContentProvenance({ type: 'markdown' })).toBe('unknown');
    expect(deriveDocumentContentProvenance({ type: 'markdown', storageUrl: '   ' })).toBe('unknown');
  });
});

describe('deriveMentionSourceReviewState', () => {
  it('treats a missing or non-positive timestamp as unreviewed', () => {
    expect(deriveMentionSourceReviewState({})).toBe('unreviewed');
    expect(deriveMentionSourceReviewState({ contentReviewedAt: null })).toBe('unreviewed');
    expect(deriveMentionSourceReviewState({ contentReviewedAt: 0 })).toBe('unreviewed');
    expect(deriveMentionSourceReviewState(null)).toBe('unreviewed');
  });

  it('treats a real timestamp as reviewed', () => {
    expect(deriveMentionSourceReviewState({ contentReviewedAt: 1_700_000_000_000 })).toBe('reviewed');
  });
});

describe('deriveMentionTrust', () => {
  // The GRAPH-064 headline: a weak model draft must never mint a curated,
  // confidence-100 mention.
  it('never lets an unreviewed machine-generated source claim curated confidence', () => {
    const trust = deriveMentionTrust('machine-generated', 'unreviewed');
    expect(trust.claimStatus).toBe('unverified');
    expect(trust.confidence).toBe(UNREVIEWED_MENTION_CONFIDENCE);
    expect(trust.confidence).toBeLessThan(75);
    expect(trust.aiSuggested).toBe(true);
  });

  it('never lets an unclassifiable source claim curated confidence', () => {
    const trust = deriveMentionTrust('unknown', 'unreviewed');
    expect(trust.claimStatus).toBe('unverified');
    expect(trust.confidence).toBe(UNREVIEWED_MENTION_CONFIDENCE);
  });

  it('lets externally-sourced content carry curated-grade mentions', () => {
    const trust = deriveMentionTrust('external', 'unreviewed');
    expect(trust.claimStatus).toBe('curated');
    expect(trust.confidence).toBe(REVIEWED_MENTION_CONFIDENCE);
    expect(trust.aiSuggested).toBe(false);
  });

  it('promotes a machine-generated source once a human reviews it', () => {
    const trust = deriveMentionTrust('machine-generated', 'reviewed');
    expect(trust.claimStatus).toBe('curated');
    expect(trust.confidence).toBe(REVIEWED_MENTION_CONFIDENCE);
    // The human vouched for the text; they did not stop the model from writing
    // it. Provenance is a fact about the source and never changes.
    expect(trust.aiSuggested).toBe(true);
    expect(trust.sourceProvenance).toBe('machine-generated');
    expect(trust.sourceReviewState).toBe('reviewed');
  });

  it('demotes again when the review is withdrawn', () => {
    expect(deriveMentionTrust('machine-generated', 'reviewed').claimStatus).toBe('curated');
    expect(deriveMentionTrust('machine-generated', 'unreviewed').claimStatus).toBe('unverified');
  });
});

describe('deriveMentionTrustForDocument', () => {
  it('derives both halves from one document record', () => {
    expect(deriveMentionTrustForDocument({ type: 'markdown', tags: ['deep-research'] })).toMatchObject({
      claimStatus: 'unverified',
      confidence: UNREVIEWED_MENTION_CONFIDENCE,
      sourceProvenance: 'machine-generated',
      sourceReviewState: 'unreviewed',
    });

    expect(
      deriveMentionTrustForDocument({
        type: 'markdown',
        tags: ['deep-research'],
        contentReviewedAt: 1_700_000_000_000,
      })
    ).toMatchObject({
      claimStatus: 'curated',
      confidence: REVIEWED_MENTION_CONFIDENCE,
      sourceProvenance: 'machine-generated',
      sourceReviewState: 'reviewed',
    });
  });
});
