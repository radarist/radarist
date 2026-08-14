import {
  authorizeExplicitRelationWrite,
  authorizeExplicitRelationPredicate,
  authorizeProposalDecision,
  type RelationWriteAuthorityContext,
  type RelationWriteEndpoint,
} from '../relation-write-authority';

const source: RelationWriteEndpoint = { id: 'tech-quantum-1', name: 'Quantum Computing' };
const target: RelationWriteEndpoint = { id: 'doc-advantage-1', name: 'Quantum Advantage' };

const human = (confirmationText?: string): RelationWriteAuthorityContext => ({
  principal: 'human',
  confirmationText,
});

describe('authorizeExplicitRelationPredicate', () => {
  it('allows a neutral custom link without inferring stronger semantics', () => {
    expect(
      authorizeExplicitRelationPredicate(
        human('Link Quantum Computing to Quantum Advantage.'),
        'custom',
        source,
        target
      ).authorized
    ).toBe(true);
  });

  it.each([
    ['uses', 'Link Quantum Computing to Quantum Advantage because Quantum Computing uses Quantum Advantage.'],
    ['uses', 'Link Quantum Computing to Quantum Advantage with relation type uses.'],
    ['uses', 'Link Quantum Computing to Quantum Advantage. Quantum Computing uses Quantum Advantage.'],
    ['documented_in', 'Link Quantum Computing to Quantum Advantage as documented in that source.'],
    ['vendor', 'Link Quantum Computing to Quantum Advantage as vendor.'],
  ])('allows an explicitly stated %s predicate', (relationType, message) => {
    expect(authorizeExplicitRelationPredicate(human(message), relationType, source, target).authorized).toBe(true);
  });

  // AI-020 — bounded canonical typed-directive forms must authorize their predicate.
  it.each([
    ['vendor', 'Create a vendor relationship between Quantum Computing and Quantum Advantage.'],
    ['uses', 'Add a uses relationship between Quantum Computing and Quantum Advantage.'],
    ['vendor', 'Connect Quantum Computing as vendor to Quantum Advantage.'],
    ['vendor', 'Connect Quantum Computing as a vendor to Quantum Advantage.'],
    ['vendor', 'Create a vendor relationship between Quantum Advantage and Quantum Computing.'],
    ['competes_with', 'Create a competes with relationship between Quantum Computing and Quantum Advantage.'],
    ['partner', 'Please create a partner relation between Quantum Computing and Quantum Advantage.'],
  ])('AI-020: allows the bounded explicit %s directive form', (relationType, message) => {
    expect(authorizeExplicitRelationPredicate(human(message), relationType, source, target).authorized).toBe(true);
  });

  it.each([
    'Link Quantum Advantage to Quantum Computing as vendor.',
    'Link Quantum Advantage to Quantum Computing with relation type vendor.',
    'Link Quantum Computing to Quantum Advantage. Quantum Advantage is vendor of Quantum Computing.',
    'Link Quantum Computing to Quantum Advantage. Relation type vendor.',
  ])('AI-020: a reversed neutral pair cannot donate stronger vendor semantics: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(true);
    expect(authorizeExplicitRelationPredicate(human(message), 'vendor', source, target).authorized).toBe(false);
  });

  it.each([
    ['vendor', 'Link Quantum Computing to Quantum Advantage. Do not create a vendor relationship.'],
    ['vendor', 'Link Quantum Computing to Quantum Advantage. Never create a vendor relationship between them.'],
    ['vendor', 'Link Quantum Computing to Quantum Advantage. Could a vendor relationship make sense?'],
    ['vendor', 'Link Quantum Computing to Quantum Advantage. Maybe create a vendor relationship later.'],
  ])(
    'AI-020: a negated, speculative, or interrogative typed clause never authorizes the %s predicate',
    (relationType, message) => {
      expect(authorizeExplicitRelationPredicate(human(message), relationType, source, target).authorized).toBe(false);
    }
  );

  it('refuses a model-inferred stronger predicate', () => {
    expect(
      authorizeExplicitRelationPredicate(human('Link Quantum Computing to Quantum Advantage.'), 'uses', source, target)
        .authorized
    ).toBe(false);
  });

  it('does not mistake predicate text inside an entity name for user-authorized semantics', () => {
    const namedSource = { id: 'company-uses-ai', name: 'Uses AI' };
    expect(
      authorizeExplicitRelationPredicate(human('Link Uses AI to Quantum Advantage.'), 'uses', namedSource, target)
        .authorized
    ).toBe(false);
  });

  it.each([
    ['uses', 'Use the assistant to link Quantum Computing to Quantum Advantage.'],
    ['uses', 'Link Quantum Computing to Quantum Advantage and use concise wording.'],
    ['about', 'Link Quantum Computing to Quantum Advantage and tell me about it.'],
  ])('does not treat incidental %s language as a bound predicate', (relationType, message) => {
    expect(authorizeExplicitRelationPredicate(human(message), relationType, source, target).authorized).toBe(false);
  });
});

describe('authorizeExplicitRelationWrite', () => {
  it.each([
    'Link Quantum Computing to Quantum Advantage.',
    'Please connect tech-quantum-1 with doc-advantage-1.',
    'Relate Quantum Computing to doc-advantage-1.',
    'Create a relation between tech-quantum-1 and Quantum Advantage.',
    'Add the relationship from Quantum Computing to Quantum Advantage.',
    'Can you link Quantum Computing to Quantum Advantage?',
    'Could you please connect Quantum Computing with Quantum Advantage?',
    'Would you relate tech-quantum-1 to Quantum Advantage?',
    'Will you please create a relation between Quantum Computing and doc-advantage-1?',
    'Link "Quantum Computing" to "Quantum Advantage".',
  ])('authorizes a direct human command naming both authoritative endpoints: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(true);
  });

  // AI-020 — bounded canonical typed-directive forms must authorize the pair.
  it.each([
    'Create a vendor relationship between Quantum Computing and Quantum Advantage.',
    'Add a uses relationship between tech-quantum-1 and Quantum Advantage.',
    'Connect Quantum Computing as vendor to Quantum Advantage.',
    'Connect Quantum Computing as a vendor to Quantum Advantage.',
    'Can you create a vendor relationship between Quantum Computing and Quantum Advantage?',
    'Create a competes with relationship between Quantum Computing and Quantum Advantage.',
    'Add an enables relationship from Quantum Computing to Quantum Advantage.',
  ])('AI-020: authorizes the bounded explicit typed form: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(true);
  });

  it.each([
    'Connect Quantum Advantage as vendor to Quantum Computing.',
    'Add a vendor relationship from Quantum Advantage to Quantum Computing.',
  ])('AI-020: refuses a directional typed form that reverses the canonical endpoints: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it('keeps typed between phrasing order-insensitive', () => {
    expect(
      authorizeExplicitRelationWrite(
        human('Create a vendor relationship between Quantum Advantage and Quantum Computing.'),
        source,
        target
      ).authorized
    ).toBe(true);
  });

  it.each([
    'Create a hypothetical relationship between Quantum Computing and Quantum Advantage.',
    'Create a possible vendor relationship between Quantum Computing and Quantum Advantage.',
    'Connect Quantum Computing as maybe a vendor to Quantum Advantage.',
    'Should we create a vendor relationship between Quantum Computing and Quantum Advantage?',
  ])('AI-020: an unbounded or speculative typed form stays rejected: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it.each([
    'If the evidence supports it, link Quantum Computing to Quantum Advantage.',
    'Do not, under any circumstances, link Quantum Computing to Quantum Advantage.',
    'Unless I say otherwise, connect Quantum Computing with Quantum Advantage.',
    'For example, connect Quantum Computing as vendor to Quantum Advantage.',
    'For instance, create a vendor relationship between Quantum Computing and Quantum Advantage.',
    'E.g., connect Quantum Computing as vendor to Quantum Advantage.',
    'I.e., link Quantum Computing to Quantum Advantage as vendor.',
    'As an example, connect Quantum Computing as vendor to Quantum Advantage.',
    'Example, connect Quantum Computing as vendor to Quantum Advantage.',
    'Suppose this, connect Quantum Computing as vendor to Quantum Advantage.',
    'Imagine that, connect Quantum Computing as vendor to Quantum Advantage.',
    'Assume this, connect Quantum Computing as vendor to Quantum Advantage.',
    'To illustrate, connect Quantum Computing as vendor to Quantum Advantage.',
    'By way of example, connect Quantum Computing as vendor to Quantum Advantage.',
  ])('screens the whole sentence, not just the post-comma clause: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it('does not confuse discovery language inside an authoritative endpoint name with discovery intent', () => {
    const namedSource = { id: 'tech-no-code', name: 'No Code' };
    const namedTarget = { id: 'tech-potential-energy', name: 'Potential Energy Storage' };

    expect(
      authorizeExplicitRelationWrite(human('Link No Code to Potential Energy Storage.'), namedSource, namedTarget)
        .authorized
    ).toBe(true);
  });

  it('masks metalinguistic and conditional words inside authoritative endpoint names', () => {
    const namedSource = { id: 'company-example', name: 'Example' };
    const namedTarget = { id: 'tech-imagine', name: 'Imagine' };

    expect(authorizeExplicitRelationWrite(human('Link Example to Imagine.'), namedSource, namedTarget).authorized).toBe(
      true
    );
  });

  it('requires disjoint endpoint mentions when names overlap', () => {
    const nestedSource = { id: 'tech-quantum', name: 'Quantum' };
    const nestedTarget = { id: 'tech-quantum-computing', name: 'Quantum Computing' };

    expect(
      authorizeExplicitRelationWrite(human('Link Quantum Computing.'), nestedSource, nestedTarget).authorized
    ).toBe(false);
    expect(
      authorizeExplicitRelationWrite(human('Link tech-quantum to Quantum Computing.'), nestedSource, nestedTarget)
        .authorized
    ).toBe(true);
  });

  it('requires exact IDs when distinct entities have the same display name', () => {
    const first = { id: 'tech-quantum-1', name: 'Quantum' };
    const second = { id: 'document-quantum-2', name: 'Quantum' };

    expect(authorizeExplicitRelationWrite(human('Link Quantum.'), first, second).authorized).toBe(false);
    expect(authorizeExplicitRelationWrite(human('Link Quantum to Quantum.'), first, second).authorized).toBe(false);
    expect(
      authorizeExplicitRelationWrite(human('Link tech-quantum-1 to document-quantum-2.'), first, second).authorized
    ).toBe(true);
  });

  it('binds authorization to the pair operated on by the direct command', () => {
    const company = { id: 'company-acme', name: 'Acme Corp' };
    const technology = { id: 'tech-qc', name: 'Quantum Computing' };
    const document = { id: 'doc-advantage', name: 'Quantum Advantage' };
    const roadmap = { id: 'doc-roadmap', name: 'Quantum Roadmap' };
    const mixedMessage =
      'Link Acme Corp to Quantum Computing. Quantum Advantage and Quantum Roadmap are also in scope.';

    expect(authorizeExplicitRelationWrite(human(mixedMessage), company, technology).authorized).toBe(true);
    expect(authorizeExplicitRelationWrite(human(mixedMessage), document, roadmap).authorized).toBe(false);

    const twoCommands = 'Link Acme Corp to Quantum Computing and link Quantum Advantage to Quantum Roadmap.';
    expect(authorizeExplicitRelationWrite(human(twoCommands), company, technology).authorized).toBe(true);
    expect(authorizeExplicitRelationWrite(human(twoCommands), document, roadmap).authorized).toBe(true);
  });

  it.each([
    [{ confirmationText: 'Link Quantum Computing to Quantum Advantage.' }, 'missing principal'],
    [{ principal: 'machine', confirmationText: 'Link Quantum Computing to Quantum Advantage.' }, 'machine'],
    [{ principal: 'human' }, 'missing raw text'],
    [{ principal: 'human', confirmationText: '   ' }, 'empty raw text'],
  ] as const)('fails closed for %s (%s)', (context, _caseName) => {
    expect(authorizeExplicitRelationWrite(context, source, target).authorized).toBe(false);
  });

  it.each([
    'Find missing relationships between Quantum Computing and Quantum Advantage.',
    'Discover whether Quantum Computing might relate to Quantum Advantage.',
    'Link Quantum Computing to Quantum Advantage if it is potentially useful.',
    'Could you link Quantum Computing to Quantum Advantage if it could be useful?',
    'Suggest a relation between Quantum Computing and Quantum Advantage.',
  ])('routes discovery or speculation to proposals: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it.each([
    'Do not link Quantum Computing to Quantum Advantage.',
    "Don't connect Quantum Computing with Quantum Advantage.",
    'Never create a relation between Quantum Computing and Quantum Advantage.',
    'Link Quantum Computing to Quantum Advantage without applying it.',
  ])('rejects negation: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it.each([
    '"Link Quantum Computing to Quantum Advantage."',
    'The instruction is to link Quantum Computing to Quantum Advantage.',
    'I said link Quantum Computing to Quantum Advantage.',
    'Explain how to link Quantum Computing to Quantum Advantage.',
  ])('rejects quoted or reported instructions: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it.each([
    'Link Quantum Computing to Quantum Advantage if the evidence supports it.',
    'Link Quantum Computing to Quantum Advantage unless there is a conflict.',
    'Link Quantum Computing to Quantum Advantage is the phrase under test.',
    'Link Quantum Computing to Quantum Advantage for this test.',
  ])('rejects conditional or metalinguistic commands: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it.each([
    'Link the wrong technology to Quantum Advantage.',
    'Link Quantum Computing to the wrong document.',
    'Link tech-quantum-10 to doc-advantage-1.',
    'Link tech-quantum-1 to doc-advantage-10.',
    'Link it to that.',
  ])('rejects missing, wrong, substring, or pronoun-only endpoints: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });

  it.each([
    'Quantum Computing and Quantum Advantage are related.',
    'Should we link Quantum Computing to Quantum Advantage?',
    'Could Quantum Computing relate to Quantum Advantage?',
  ])('requires an imperative relation command: %s', (message) => {
    expect(authorizeExplicitRelationWrite(human(message), source, target).authorized).toBe(false);
  });
});

describe('authorizeProposalDecision', () => {
  const proposalId = 'proposal-quantum-17';

  it.each([
    ['approve', 'Approve proposal-quantum-17.'],
    ['approve', 'I accept proposal-quantum-17.'],
    ['reject', 'Reject proposal-quantum-17.'],
    ['reject', 'Please decline proposal-quantum-17.'],
  ] as const)('authorizes an explicit %s decision bound to the exact proposal ID', (action, message) => {
    expect(authorizeProposalDecision(human(message), action, proposalId).authorized).toBe(true);
  });

  it.each([
    [{ principal: 'machine', confirmationText: 'Approve proposal-quantum-17.' }, 'approve', 'machine'],
    [{ principal: 'human' }, 'approve', 'missing raw text'],
    [human('Approve proposal-quantum-170.'), 'approve', 'substring ID'],
    [human('Approve that proposal.'), 'approve', 'pronoun-only ID'],
    [human('Reject proposal-quantum-17.'), 'approve', 'wrong decision verb'],
    [human('Approve proposal-quantum-17.'), 'reject', 'wrong decision verb'],
    [human('Do not approve proposal-quantum-17.'), 'approve', 'negation'],
    [human('I accept proposal-quantum-17, but not yet.'), 'approve', 'trailing negation'],
    [human('"Approve proposal-quantum-17."'), 'approve', 'quoted instruction'],
    [human('Approve proposal-quantum-17 if you think it is correct.'), 'approve', 'conditional'],
    [human('Approve proposal-quantum-17 is the phrase under test.'), 'approve', 'metalinguistic'],
    [human('Approve proposal-other. Proposal-quantum-17 is pending.'), 'approve', 'ID outside approval clause'],
    [human('Approve proposal-other and show proposal-quantum-17.'), 'approve', 'ID in read clause'],
  ] as const)('rejects an unauthorized proposal decision (%s)', (context, action, _caseName) => {
    expect(authorizeProposalDecision(context, action, proposalId).authorized).toBe(false);
  });

  it.each([
    ['If you are sure, approve proposal-quantum-17.', 'comma-spliced conditional'],
    ['Do not, I repeat, do not approve proposal-quantum-17.', 'comma-spliced negation'],
    ['For example, approve proposal-quantum-17.', 'illustrative example'],
    ['As an example, approve proposal-quantum-17.', 'as-an-example prefix'],
    ['Example, approve proposal-quantum-17.', 'leading example marker'],
    ['Suppose this, approve proposal-quantum-17.', 'hypothetical suppose prefix'],
    ['Imagine that, approve proposal-quantum-17.', 'hypothetical imagine prefix'],
    ['Assume this, approve proposal-quantum-17.', 'hypothetical assume prefix'],
  ] as const)('screens the whole sentence for a decision: %s (%s)', (message, _caseName) => {
    expect(authorizeProposalDecision(human(message), 'approve', proposalId).authorized).toBe(false);
  });

  it('rejects an empty authoritative proposal ID', () => {
    expect(authorizeProposalDecision(human('Approve proposal-quantum-17.'), 'approve', '').authorized).toBe(false);
  });

  it('masks metalinguistic words inside the authoritative proposal ID', () => {
    const id = 'proposal-example-imagine-17';
    expect(authorizeProposalDecision(human(`Approve ${id}.`), 'approve', id).authorized).toBe(true);
  });

  it('authorizes each exact proposal only when both have explicit decision clauses', () => {
    const message = 'Approve proposal-quantum-17 and approve proposal-quantum-18.';

    expect(authorizeProposalDecision(human(message), 'approve', proposalId).authorized).toBe(true);
    expect(authorizeProposalDecision(human(message), 'approve', 'proposal-quantum-18').authorized).toBe(true);
  });
});

// AI-046: a human batching several exact proposal IDs into one decision was
// refused, because the grammar accepted only the singular noun `proposal` plus
// ONE immediately-adjacent ID. Widening it must not weaken any refusal.
describe('authorizeProposalDecision — plural and multi-ID decision lists', () => {
  // Synthetic 32-character IDs preserve the multi-proposal grammar boundary.
  const ids = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
    'ccccccccccccccccccccccccccccccc3',
    'ddddddddddddddddddddddddddddddd4',
  ] as const;

  const authorizedIds = (
    message: string,
    action: 'approve' | 'reject' = 'approve',
    candidates: readonly string[] = ids
  ) => candidates.filter((id) => authorizeProposalDecision(human(message), action, id).authorized);

  it('authorizes the exact operator turn that AI-046 reproduced as fully refused', () => {
    const message = `Approve proposals ${ids[0]}, ${ids[1]}, ${ids[2]}, and ${ids[3]}`;

    expect(authorizedIds(message)).toEqual([...ids]);
  });

  it.each([
    ['plural noun with a single ID', `Approve proposals ${ids[0]}.`],
    ['singular noun with a single ID', `Approve proposal ${ids[0]}.`],
    ['no noun with a single ID', `Approve ${ids[0]}.`],
  ])('authorizes %s', (_caseName, message) => {
    expect(authorizedIds(message, 'approve', [ids[0]])).toEqual([ids[0]]);
  });

  it.each([
    ['singular noun with a list', `Approve proposal ${ids[0]}, ${ids[1]} and ${ids[2]}`],
    ['no noun with a list', `Approve ${ids[0]}, ${ids[1]} and ${ids[2]}`],
    ['serial comma before and', `Approve proposals ${ids[0]}, ${ids[1]}, and ${ids[2]}`],
    ['no serial comma', `Accept proposals ${ids[0]} and ${ids[1]} and ${ids[2]}`],
    ['quoted members', `Approve proposals "${ids[0]}", "${ids[1]}", and "${ids[2]}"`],
    ['leading please', `Please approve proposals ${ids[0]}, ${ids[1]}, and ${ids[2]}`],
  ])('authorizes every listed ID for %s', (_caseName, message) => {
    expect(authorizedIds(message, 'approve', ids.slice(0, 3))).toEqual([ids[0], ids[1], ids[2]]);
  });

  it('authorizes a plural reject list under the reject action only', () => {
    const message = `Reject proposals ${ids[0]} and ${ids[1]}`;

    expect(authorizedIds(message, 'reject', ids.slice(0, 2))).toEqual([ids[0], ids[1]]);
    expect(authorizedIds(message, 'approve', ids.slice(0, 2))).toEqual([]);
  });

  it('masks every listed ID before screening, so a metalinguistic sibling ID cannot void the decision', () => {
    // `proposal-example-imagine-17` carries `example` and `imagine` as word-boundary
    // segments; unmasked, it would trip the metalinguistic screen for its sibling.
    const message = 'Approve proposals proposal-quantum-17 and proposal-example-imagine-17.';

    expect(authorizeProposalDecision(human(message), 'approve', 'proposal-quantum-17').authorized).toBe(true);
    expect(authorizeProposalDecision(human(message), 'approve', 'proposal-example-imagine-17').authorized).toBe(true);
  });

  it.each([
    ['trailing negation after the list', `Approve proposals ${ids[0]} and ${ids[1]}, but not ${ids[2]}`],
    ['exclusion clause', `Approve proposals ${ids[0]} and ${ids[1]} except ${ids[2]}`],
    ['non-ID filler inside the list', `Approve proposals ${ids[0]}, everything else, and ${ids[2]}`],
    ['read clause after the list', `Approve proposals ${ids[0]} and ${ids[1]} and show ${ids[2]}`],
    ['leading negation', `Do not approve proposals ${ids[0]}, ${ids[1]}, and ${ids[2]}`],
    ['conditional prefix', `If you are sure, approve proposals ${ids[0]}, ${ids[1]}, and ${ids[2]}`],
    ['comma-spliced negation', `Do not, I repeat, do not approve proposals ${ids[0]} and ${ids[1]}`],
    ['illustrative example', `For example, approve proposals ${ids[0]} and ${ids[1]}`],
    ['quoted instruction', `"Approve proposals ${ids[0]} and ${ids[1]}."`],
    ['reported instruction', `The user said approve proposals ${ids[0]} and ${ids[1]}`],
  ])('refuses every ID for %s', (_caseName, message) => {
    expect(authorizedIds(message)).toEqual([]);
  });

  it('refuses an ID that only appears in a later non-decision sentence', () => {
    const message = `Approve proposals ${ids[0]} and ${ids[1]}. Proposal ${ids[2]} is still pending.`;

    expect(authorizedIds(message)).toEqual([ids[0], ids[1]]);
  });

  it('refuses the opposite decision named in its own clause', () => {
    const message = `Approve proposals ${ids[0]} and ${ids[1]}, and reject ${ids[2]}`;

    expect(authorizedIds(message, 'approve')).toEqual([ids[0], ids[1]]);
    expect(authorizedIds(message, 'reject')).toEqual([ids[2]]);
  });

  it('refuses a substring ID that is not an exact list member', () => {
    const message = `Approve proposals ${ids[0]}, proposal-quantum-170`;

    expect(authorizeProposalDecision(human(message), 'approve', 'proposal-quantum-17').authorized).toBe(false);
  });

  it('refuses a machine principal even with a well-formed list', () => {
    const message = `Approve proposals ${ids[0]}, ${ids[1]}, and ${ids[2]}`;

    expect(
      ids
        .slice(0, 3)
        .filter(
          (id) =>
            authorizeProposalDecision({ principal: 'machine', confirmationText: message }, 'approve', id).authorized
        )
    ).toEqual([]);
  });
});
