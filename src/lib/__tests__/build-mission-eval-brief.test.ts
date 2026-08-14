/**
 * @jest-environment node
 */

/**
 * @file Tests for the Technology-Evaluation brief composer (E1).
 * The brief is the judgment instrument — it must pull the real repo + the
 * linked use cases from the graph and demand a machine-readable verdict.
 */

const docs: Record<string, Record<string, unknown> | undefined> = {};
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs[`${name}/${id}`];
          return { exists: Boolean(data), data: () => data };
        },
      }),
    }),
  },
}));

const { composeEvaluationBrief, UnsupportedEvaluationEntityError } = require('../build-mission-eval-brief');

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
});

describe('composeEvaluationBrief', () => {
  it('composes a brief from the technology + its linked use cases', async () => {
    docs['technologies/tech-neo4j'] = {
      name: 'Neo4j',
      description: 'A graph database.',
      category: 'Database',
      githubUrl: 'https://github.com/neo4j/neo4j',
      documentationUrl: 'https://neo4j.com/docs',
      linkedUseCases: ['uc-graph'],
    };
    docs['use-cases/uc-graph'] = { title: 'Graph queries on our radar', problem: 'Slow multi-hop traversals' };

    const out = await composeEvaluationBrief('tech-neo4j');

    expect(out.title).toBe('Evaluate Neo4j');
    // Motivation now also carries the dimension-agnostic fields (P1a-T3): for a
    // technology both sourceTechnologyId and sourceEntityId are set + entityType.
    expect(out.motivation).toEqual({
      sourceTechnologyId: 'tech-neo4j',
      sourceEntityId: 'tech-neo4j',
      entityType: 'technology',
      useCaseIds: ['uc-graph'],
      painPointIds: [],
      strategyIds: [],
    });
    // pulls the REAL repo, the use case, and demands a machine-readable verdict
    expect(out.brief).toContain('https://github.com/neo4j/neo4j');
    expect(out.brief).toContain('Graph queries on our radar');
    expect(out.brief).toContain('.impulse/verdict.json');
    expect(out.brief).toContain('# Mission: Evaluate Neo4j');
    // it's an evidence artifact, not a pretty app
    expect(out.brief.toLowerCase()).toContain('verdict');
  });

  it('honors explicit useCaseIds over the technology’s linked ones', async () => {
    docs['technologies/t1'] = { name: 'X', linkedUseCases: ['uc-default'] };
    docs['use-cases/uc-chosen'] = { title: 'Chosen UC', description: 'd' };
    const out = await composeEvaluationBrief('t1', { useCaseIds: ['uc-chosen'] });
    expect(out.motivation.useCaseIds).toEqual(['uc-chosen']);
    expect(out.brief).toContain('Chosen UC');
  });

  it('handles a technology with no repo and no use cases (records the gap)', async () => {
    docs['technologies/t2'] = { name: 'Mystery Lib' };
    const out = await composeEvaluationBrief('t2');
    expect(out.brief).toContain('No repo URL is recorded');
    expect(out.brief).toContain('No use case is linked');
    expect(out.motivation.useCaseIds).toEqual([]);
  });

  it('throws when the technology does not exist', async () => {
    await expect(composeEvaluationBrief('missing')).rejects.toThrow(/not found/);
  });

  it('throws UnsupportedEvaluationEntityError for an entityType with no composer (the seam)', async () => {
    await expect(composeEvaluationBrief('c1', { entityType: 'company' })).rejects.toThrow(
      UnsupportedEvaluationEntityError
    );
  });

  describe('useCase composer (non-technology breadth)', () => {
    it('composes a useCase evaluation routed to the ENTITY channel (entityType useCase, no sourceTechnologyId)', async () => {
      docs['use-cases/uc1'] = {
        title: 'Real-time fraud detection',
        description: 'Detect fraud in <100ms',
        problem: 'Fraud slips through nightly batch checks',
      };

      const out = await composeEvaluationBrief('uc1', { entityType: 'useCase' });

      // No sourceTechnologyId → resolveEvaluationPublishChannel routes to 'entity', not 'assessment'.
      expect(out.motivation).toEqual({
        sourceEntityId: 'uc1',
        entityType: 'useCase',
        useCaseIds: [], // the subject is in sourceEntityId, not the motivating-links array
        painPointIds: [],
        strategyIds: [],
      });
      expect(out.motivation.sourceTechnologyId).toBeUndefined();
      // Pulls the real use case (title + problem) and demands the machine-readable verdict.
      expect(out.title).toContain('Real-time fraud detection');
      expect(out.brief).toContain('Real-time fraud detection');
      expect(out.brief).toContain('Fraud slips through nightly batch checks');
      expect(out.brief).toContain('.impulse/verdict.json');
      // recommendation MUST use the shared verdictSchema enum (adopt|trial|assess|hold);
      // the rejected vocabulary (pursue|monitor|drop) would make readVerdict drop the whole verdict.
      expect(out.brief).toContain('adopt | trial | assess | hold');
      expect(out.brief).not.toContain('pursue | trial | monitor | drop');
    });

    it('throws when the use case does not exist', async () => {
      await expect(composeEvaluationBrief('missing-uc', { entityType: 'useCase' })).rejects.toThrow(/not found/);
    });
  });
});
