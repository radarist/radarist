/**
 * Real Firestore-emulator acceptance for GRAPH-046 pending triage visibility.
 *
 * Runs unconditionally in `npm run test:emulator`, whose owned demo project
 * and emulator lifecycle are the safety boundary.
 */
import type { EntityType } from '@/lib/types';
import {
  GRAPH_REACHABILITY_ALGORITHM,
  GRAPH_REACHABILITY_OPERATION,
  GRAPH_REACHABILITY_SCHEMA_VERSION,
  authorizeAndStageTriageCandidates,
  buildGraphReachabilityPlan,
  buildReachabilityBenchmark,
  buildStageConfirmation,
  buildTriageCandidateBatch,
  classifyDisconnectedDecisionEntity,
  type ClassifiedDisconnected,
  type GraphReachabilityTarget,
} from '../../scripts/lib/graph-reachability';

describe('GRAPH-046 canonical pending-triage contract (Firestore emulator)', () => {
  it('is visible through the canonical pending reader, replays exactly once, and leaves zero residue', async () => {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (!projectId?.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('GRAPH-046 emulator acceptance requires a demo-* project and Firestore emulator host');
    }
    // The Jest emulator lane is Node-based for firebase-admin. `firebase.ts`
    // deliberately exports a lazy SSR proxy when no browser global exists,
    // which modular Firestore queries must not consume. relations-admin loads
    // shared client error classes, so the browser marker must exist before the
    // first service import. Node export conditions remain unchanged.
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
      writable: true,
    });
    const [
      { db },
      relationsAdmin,
      proposalAdmin,
      { executeListPendingProposedRelations },
      { getProposedRelations },
      firebaseClient,
    ] =
      await Promise.all([
        import('@/lib/firebase-admin'),
        import('@/lib/relations-admin'),
        import('@/lib/proposed-relations-admin'),
        import('@/lib/ai/tools/linker-tools'),
        import('@/lib/proposed-relations'),
        import('@/lib/firebase'),
      ]).finally(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
      });
    const suffix = `${Date.now()}-${process.pid}`;
    const technologyId = `tech-graph-046-${suffix}`;
    const painPointId = `graph-046-pain-${suffix}`;
    const createdProposalIds = new Set<string>();
    const target: GraphReachabilityTarget = {
      neo4jUri: 'bolt://127.0.0.1:17687',
      neo4jDatabase: 'neo4j',
      neo4jDatabaseId: `disposable-graph-046-${suffix}`,
      firestoreProjectId: projectId,
      firestoreDatabaseId: '(default)',
      firestoreMode: 'emulator',
      firestoreEndpoint: process.env.FIRESTORE_EMULATOR_HOST,
    };
    const technologyTags = ['gpu', 'latency', 'serving'];
    const painPointTags = ['gpu', 'latency', 'inference'];

    try {
      await Promise.all([
        db.collection('technologies').doc(technologyId).set({
          id: technologyId,
          name: 'GRAPH-046 Emulator Technology',
          description: 'Disposable technology endpoint',
          tags: technologyTags,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: 'graph-046-emulator',
        }),
        db.collection('painPoints').doc(painPointId).set({
          id: painPointId,
          title: 'GRAPH-046 Emulator Pain Point',
          description: 'Disposable pain-point endpoint',
          tags: painPointTags,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: 'graph-046-emulator',
        }),
      ]);

      const decision = {
        label: 'PainPoint' as const,
        id: painPointId,
        name: 'GRAPH-046 Emulator Pain Point',
        tags: painPointTags,
        neighborLabels: [],
      };
      const classified: ClassifiedDisconnected = {
        node: decision,
        ...classifyDisconnectedDecisionEntity({
          node: decision,
          candidates: [
            {
              label: 'Technology',
              id: technologyId,
              name: 'GRAPH-046 Emulator Technology',
              tags: technologyTags,
            },
          ],
          minOverlap: 2,
        }),
      };
      const plan = buildGraphReachabilityPlan({
        schemaVersion: GRAPH_REACHABILITY_SCHEMA_VERSION,
        operation: GRAPH_REACHABILITY_OPERATION,
        algorithm: GRAPH_REACHABILITY_ALGORITHM,
        target,
        policy: { minTagOverlap: 2, triageTopN: 1, signalProjection: 'approved-or-referenced' },
        benchmark: buildReachabilityBenchmark([
          { label: 'PainPoint', total: 1, businessReachable: 0, memoryOnly: 0, disconnected: 1 },
        ]),
        signalPolicyBreakdown: {
          policyCorrectInbox: 0,
          eligibleButUnlinked: 0,
          policyIneligibleProjected: 0,
          policyIneligibleProjectedIds: [],
        },
        entityProjectionResync: [],
        candidateProjectionResync: [],
        relationProjectionResync: [],
        gapBreakdown: {
          PainPoint: {
            'inferable-candidate': 1,
            'ambiguous-candidate': 0,
            'curation-gap-no-evidence': 0,
            'untagged-gap': 0,
            'graph-only-source-drift': 0,
          },
          UseCase: {
            'inferable-candidate': 0,
            'ambiguous-candidate': 0,
            'curation-gap-no-evidence': 0,
            'untagged-gap': 0,
            'graph-only-source-drift': 0,
          },
        },
        triage: buildTriageCandidateBatch([classified], { topN: 1 }),
      });

      const resolveEvidenceEntity = async (id: string, type: EntityType) => {
        const [snapshot, document] = await Promise.all([
          relationsAdmin.buildEntitySnapshot(id, type),
          db.collection(type === 'technology' ? 'technologies' : 'painPoints').doc(id).get(),
        ]);
        return { snapshot, tags: (document.data()?.tags as string[]) ?? [] };
      };
      const dependencies = {
        resolveEvidenceEntity,
        // Neo4j state is independently covered by the injected unit contract;
        // this owned lane proves the real Firestore proposal/triage boundary.
        assertStillBusinessUnreachable: async () => undefined,
        findExistingRelation: relationsAdmin.adminCheckDuplicateRelation,
        createProposal: async (input: Parameters<typeof proposalAdmin.createProposedRelationIfNotExists>[0]) => {
          const result = await proposalAdmin.createProposedRelationIfNotExists(input);
          createdProposalIds.add(result.proposal.id);
          return result;
        },
        now: () => Date.now(),
      };
      const authorization = {
        currentTarget: target,
        expectedPlanSha256: plan.planSha256,
        confirmation: buildStageConfirmation(target, plan.planSha256),
      };

      const firstStage = await authorizeAndStageTriageCandidates(plan, authorization, dependencies);
      if (!firstStage.ok) throw new Error(`GRAPH-046 staging failed: ${JSON.stringify(firstStage.outcomes)}`);
      expect(firstStage).toMatchObject({
        ok: true,
        created: 1,
        deduplicated: 0,
      });
      const visiblePending = (await proposalAdmin.getProposedRelations({ status: 'pending' })).filter(
        (proposal) => proposal.sourceId === technologyId && proposal.targetId === painPointId
      );
      expect(visiblePending).toHaveLength(1);
      expect(visiblePending[0]).toMatchObject({
        status: 'pending',
        relationType: 'solves',
        discoveredBy: 'linker-agent',
      });

      // Exercise both product consumers, not merely their shared collection:
      // the client query is the queryFn behind usePendingProposedRelations on
      // /triage/relations, and the tool executor is the Assistant read path.
      const triageClientRows = (await getProposedRelations({ status: 'pending' })).filter(
        (proposal) => proposal.sourceId === technologyId && proposal.targetId === painPointId
      );
      expect(triageClientRows).toHaveLength(1);
      expect(triageClientRows[0]).toMatchObject({
        id: visiblePending[0].id,
        status: 'pending',
        sourceSnapshot: { id: technologyId, name: 'GRAPH-046 Emulator Technology' },
        targetSnapshot: { id: painPointId, name: 'GRAPH-046 Emulator Pain Point' },
        relationType: 'solves',
      });

      const assistantResult = await executeListPendingProposedRelations({ status: 'pending', limit: 50 });
      expect(assistantResult.success).toBe(true);
      const assistantRows = assistantResult.data?.proposals.filter(
        (proposal) => proposal.id === visiblePending[0].id
      );
      expect(assistantRows).toEqual([
        expect.objectContaining({
          id: visiblePending[0].id,
          sourceName: 'GRAPH-046 Emulator Technology',
          targetName: 'GRAPH-046 Emulator Pain Point',
          relationType: 'solves',
        }),
      ]);

      await expect(authorizeAndStageTriageCandidates(plan, authorization, dependencies)).resolves.toMatchObject({
        ok: true,
        created: 0,
        deduplicated: 1,
      });
      const afterReplay = (await proposalAdmin.getProposedRelations({ status: 'pending' })).filter(
        (proposal) => proposal.sourceId === technologyId && proposal.targetId === painPointId
      );
      expect(afterReplay).toHaveLength(1);
      const relations = await db.collection('relations').get();
      expect(
        relations.docs.filter((document) => {
          const data = document.data();
          return data.sourceSnapshot?.id === technologyId || data.targetSnapshot?.id === painPointId;
        })
      ).toHaveLength(0);
    } finally {
      await Promise.all([
        ...[...createdProposalIds].map((id) => db.collection('proposedRelations').doc(id).delete()),
        db.collection('technologies').doc(technologyId).delete(),
        db.collection('painPoints').doc(painPointId).delete(),
      ]);
      const residue = await Promise.all([
        ...[...createdProposalIds].map((id) => db.collection('proposedRelations').doc(id).get()),
        db.collection('technologies').doc(technologyId).get(),
        db.collection('painPoints').doc(painPointId).get(),
      ]);
      expect(residue.every((document) => !document.exists)).toBe(true);
      const [{ terminate }, { deleteApp }] = await Promise.all([
        import('firebase/firestore'),
        import('firebase/app'),
      ]);
      await terminate(firebaseClient.db);
      await deleteApp(firebaseClient.app);
    }
  });
});
