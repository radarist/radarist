/**
 * Tests for query-keys.ts - TanStack Query Key Factories
 * @jest-environment node
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  getDocs: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
}));

import {
  companyKeys,
  technologyKeys,
  useCaseKeys,
  prototypeKeys,
  strategyKeys,
  signalKeys,
  relationKeys,
  agentKeys,
  dashboardKeys,
  radarKeys,
  radarPlacementKeys,
  documentKeys,
  documentChunkKeys,
  entityDocumentLinkKeys,
  orgUnitKeys,
  initiativeKeys,
  painPointKeys,
  proposedRelationKeys,
  linkerMetricsKeys,
} from '../query-keys';

describe('Query Key Factories', () => {
  describe('companyKeys', () => {
    it('should have correct base key', () => {
      expect(companyKeys.all).toEqual(['companies']);
    });
    it('lists() extends all', () => {
      expect(companyKeys.lists()).toEqual(['companies', 'list']);
    });
    it('list() includes filters', () => {
      expect(companyKeys.list({ searchQuery: 'acme' })).toEqual(['companies', 'list', { searchQuery: 'acme' }]);
    });
    it('list() without filters', () => {
      expect(companyKeys.list()).toEqual(['companies', 'list', undefined]);
    });
    it('details() extends all', () => {
      expect(companyKeys.details()).toEqual(['companies', 'detail']);
    });
    it('detail() includes id', () => {
      expect(companyKeys.detail('c-1')).toEqual(['companies', 'detail', 'c-1']);
    });
    it('relations() includes entity id', () => {
      expect(companyKeys.relations('c-1')).toEqual(['companies', 'detail', 'c-1', 'relations']);
    });
    it('notes() includes entity id', () => {
      expect(companyKeys.notes('c-1')).toEqual(['companies', 'detail', 'c-1', 'notes']);
    });
    it('documents() includes entity id', () => {
      expect(companyKeys.documents('c-1')).toEqual(['companies', 'detail', 'c-1', 'documents']);
    });
  });

  describe('technologyKeys', () => {
    it('all', () => expect(technologyKeys.all).toEqual(['technologies']));
    it('lists', () => expect(technologyKeys.lists()).toEqual(['technologies', 'list']));
    it('list with filters', () => {
      expect(technologyKeys.list({ category: 'framework' })).toEqual([
        'technologies',
        'list',
        { category: 'framework' },
      ]);
    });
    it('details', () => expect(technologyKeys.details()).toEqual(['technologies', 'detail']));
    it('detail', () => expect(technologyKeys.detail('t-1')).toEqual(['technologies', 'detail', 't-1']));
    it('bySlug', () => expect(technologyKeys.bySlug('react')).toEqual(['technologies', 'slug', 'react']));
    it('relations', () =>
      expect(technologyKeys.relations('t-1')).toEqual(['technologies', 'detail', 't-1', 'relations']));
    it('placements', () =>
      expect(technologyKeys.placements('t-1')).toEqual(['technologies', 'detail', 't-1', 'placements']));
    it('withPlacements', () =>
      expect(technologyKeys.withPlacements('r-1')).toEqual(['technologies', 'withPlacements', 'r-1']));
  });

  describe('useCaseKeys', () => {
    it('all', () => expect(useCaseKeys.all).toEqual(['useCases']));
    it('lists', () => expect(useCaseKeys.lists()).toEqual(['useCases', 'list']));
    it('list', () =>
      expect(useCaseKeys.list({ status: 'active' })).toEqual(['useCases', 'list', { status: 'active' }]));
    it('detail', () => expect(useCaseKeys.detail('uc-1')).toEqual(['useCases', 'detail', 'uc-1']));
    it('relations', () => expect(useCaseKeys.relations('uc-1')).toEqual(['useCases', 'detail', 'uc-1', 'relations']));
  });

  describe('prototypeKeys', () => {
    it('all', () => expect(prototypeKeys.all).toEqual(['prototypes']));
    it('kanban', () => expect(prototypeKeys.kanban()).toEqual(['prototypes', 'kanban']));
    it('detail', () => expect(prototypeKeys.detail('p-1')).toEqual(['prototypes', 'detail', 'p-1']));
    it('relations', () => expect(prototypeKeys.relations('p-1')).toEqual(['prototypes', 'detail', 'p-1', 'relations']));
    it('lists', () => expect(prototypeKeys.lists()).toEqual(['prototypes', 'list']));
    it('list', () =>
      expect(prototypeKeys.list({ status: 'active' })).toEqual(['prototypes', 'list', { status: 'active' }]));
  });

  describe('strategyKeys', () => {
    it('all', () => expect(strategyKeys.all).toEqual(['strategies']));
    it('detail', () => expect(strategyKeys.detail('s-1')).toEqual(['strategies', 'detail', 's-1']));
    it('relations', () => expect(strategyKeys.relations('s-1')).toEqual(['strategies', 'detail', 's-1', 'relations']));
    it('lists', () => expect(strategyKeys.lists()).toEqual(['strategies', 'list']));
    it('list', () => expect(strategyKeys.list()).toEqual(['strategies', 'list', undefined]));
  });

  describe('signalKeys', () => {
    it('all', () => expect(signalKeys.all).toEqual(['signals']));
    it('pending', () => expect(signalKeys.pending()).toEqual(['signals', 'pending']));
    it('detail', () => expect(signalKeys.detail('sig-1')).toEqual(['signals', 'detail', 'sig-1']));
    it('list with filters', () => {
      expect(signalKeys.list({ status: 'Triage', source: 'rss' })).toEqual([
        'signals',
        'list',
        { status: 'Triage', source: 'rss' },
      ]);
    });
    it('lists', () => expect(signalKeys.lists()).toEqual(['signals', 'list']));
    it('details', () => expect(signalKeys.details()).toEqual(['signals', 'detail']));
  });

  describe('relationKeys', () => {
    it('all', () => expect(relationKeys.all).toEqual(['relations']));
    it('bySource', () => expect(relationKeys.bySource('src-1')).toEqual(['relations', 'source', 'src-1']));
    it('byTarget', () => expect(relationKeys.byTarget('tgt-1')).toEqual(['relations', 'target', 'tgt-1']));
    it('byEntity', () => expect(relationKeys.byEntity('e-1')).toEqual(['relations', 'entity', 'e-1']));
  });

  describe('agentKeys', () => {
    it('all', () => expect(agentKeys.all).toEqual(['agents']));
    it('lists', () => expect(agentKeys.lists()).toEqual(['agents', 'list']));
    it('activities', () => expect(agentKeys.activities()).toEqual(['agents', 'activities']));
    it('activity', () => expect(agentKeys.activity('a-1')).toEqual(['agents', 'activities', 'a-1']));
    it('custom', () => expect(agentKeys.custom()).toEqual(['agents', 'custom']));
  });

  describe('dashboardKeys', () => {
    it('all', () => expect(dashboardKeys.all).toEqual(['dashboard']));
    it('stats', () => expect(dashboardKeys.stats()).toEqual(['dashboard', 'stats']));
    it('recentActivity', () => expect(dashboardKeys.recentActivity()).toEqual(['dashboard', 'recentActivity']));
    it('pendingApprovals', () => expect(dashboardKeys.pendingApprovals()).toEqual(['dashboard', 'pendingApprovals']));
  });

  describe('radarKeys', () => {
    it('all', () => expect(radarKeys.all).toEqual(['radar']));
    it('list', () => expect(radarKeys.list()).toEqual(['radar', 'list']));
    it('detail', () => expect(radarKeys.detail('r-1')).toEqual(['radar', 'detail', 'r-1']));
    it('entries', () => expect(radarKeys.entries()).toEqual(['radar', 'entries']));
    it('entriesByRadar', () => expect(radarKeys.entriesByRadar('r-1')).toEqual(['radar', 'entries', 'r-1']));
    it('config', () => expect(radarKeys.config()).toEqual(['radar', 'config']));
    it('lists', () => expect(radarKeys.lists()).toEqual(['radar', 'list']));
    it('details', () => expect(radarKeys.details()).toEqual(['radar', 'detail']));
  });

  describe('radarPlacementKeys', () => {
    it('all', () => expect(radarPlacementKeys.all).toEqual(['radarPlacements']));
    it('lists', () => expect(radarPlacementKeys.lists()).toEqual(['radarPlacements', 'list']));
    it('list with filters', () => {
      expect(radarPlacementKeys.list({ radarId: 'r-1', ring: 'Adopt' })).toEqual([
        'radarPlacements',
        'list',
        { radarId: 'r-1', ring: 'Adopt' },
      ]);
    });
    it('byRadar', () => expect(radarPlacementKeys.byRadar('r-1')).toEqual(['radarPlacements', 'radar', 'r-1']));
    it('byTechnology', () =>
      expect(radarPlacementKeys.byTechnology('t-1')).toEqual(['radarPlacements', 'technology', 't-1']));
    it('detail', () => expect(radarPlacementKeys.detail('p-1')).toEqual(['radarPlacements', 'detail', 'p-1']));
    it('details', () => expect(radarPlacementKeys.details()).toEqual(['radarPlacements', 'detail']));
  });

  describe('documentKeys', () => {
    it('all', () => expect(documentKeys.all).toEqual(['documents']));
    it('list', () => expect(documentKeys.list({ type: 'pdf' })).toEqual(['documents', 'list', { type: 'pdf' }]));
    it('detail', () => expect(documentKeys.detail('d-1')).toEqual(['documents', 'detail', 'd-1']));
    it('chunks', () => expect(documentKeys.chunks('d-1')).toEqual(['documents', 'detail', 'd-1', 'chunks']));
    it('search', () => expect(documentKeys.search('AI')).toEqual(['documents', 'search', 'AI']));
    it('byTag', () => expect(documentKeys.byTag('tech')).toEqual(['documents', 'tag', 'tech']));
    it('lists', () => expect(documentKeys.lists()).toEqual(['documents', 'list']));
    it('details', () => expect(documentKeys.details()).toEqual(['documents', 'detail']));
  });

  describe('documentChunkKeys', () => {
    it('all', () => expect(documentChunkKeys.all).toEqual(['documentChunks']));
    it('byDocument', () => expect(documentChunkKeys.byDocument('d-1')).toEqual(['documentChunks', 'document', 'd-1']));
    it('detail', () => expect(documentChunkKeys.detail('ch-1')).toEqual(['documentChunks', 'detail', 'ch-1']));
    it('search', () => expect(documentChunkKeys.search('AI', 10)).toEqual(['documentChunks', 'search', 'AI', 10]));
  });

  describe('entityDocumentLinkKeys', () => {
    it('all', () => expect(entityDocumentLinkKeys.all).toEqual(['entityDocumentLinks']));
    it('lists', () => expect(entityDocumentLinkKeys.lists()).toEqual(['entityDocumentLinks', 'list']));
    it('list with filters', () => {
      expect(entityDocumentLinkKeys.list({ entityType: 'company' })).toEqual([
        'entityDocumentLinks',
        'list',
        { entityType: 'company' },
      ]);
    });
    it('byEntity', () =>
      expect(entityDocumentLinkKeys.byEntity('company', 'c-1')).toEqual([
        'entityDocumentLinks',
        'entity',
        'company',
        'c-1',
      ]));
    it('byDocument', () =>
      expect(entityDocumentLinkKeys.byDocument('d-1')).toEqual(['entityDocumentLinks', 'document', 'd-1']));
    it('withDocuments', () =>
      expect(entityDocumentLinkKeys.withDocuments('company', 'c-1')).toEqual([
        'entityDocumentLinks',
        'entity',
        'company',
        'c-1',
        'withDocuments',
      ]));
    it('detail', () => expect(entityDocumentLinkKeys.detail('l-1')).toEqual(['entityDocumentLinks', 'detail', 'l-1']));
    it('stats', () =>
      expect(entityDocumentLinkKeys.stats('company', 'c-1')).toEqual([
        'entityDocumentLinks',
        'entity',
        'company',
        'c-1',
        'stats',
      ]));
    it('pendingSync', () =>
      expect(entityDocumentLinkKeys.pendingSync()).toEqual(['entityDocumentLinks', 'pendingSync']));
    it('aiSuggestions', () =>
      expect(entityDocumentLinkKeys.aiSuggestions()).toEqual(['entityDocumentLinks', 'aiSuggestions']));
    it('details', () => expect(entityDocumentLinkKeys.details()).toEqual(['entityDocumentLinks', 'detail']));
  });

  describe('orgUnitKeys', () => {
    it('all', () => expect(orgUnitKeys.all).toEqual(['orgUnits']));
    it('tree', () => expect(orgUnitKeys.tree()).toEqual(['orgUnits', 'tree']));
    it('detail', () => expect(orgUnitKeys.detail('ou-1')).toEqual(['orgUnits', 'detail', 'ou-1']));
    it('children', () => expect(orgUnitKeys.children('ou-1')).toEqual(['orgUnits', 'children', 'ou-1']));
    it('relations', () => expect(orgUnitKeys.relations('ou-1')).toEqual(['orgUnits', 'detail', 'ou-1', 'relations']));
    it('lists', () => expect(orgUnitKeys.lists()).toEqual(['orgUnits', 'list']));
    it('list', () =>
      expect(orgUnitKeys.list({ type: 'department' })).toEqual(['orgUnits', 'list', { type: 'department' }]));
    it('details', () => expect(orgUnitKeys.details()).toEqual(['orgUnits', 'detail']));
  });

  describe('initiativeKeys', () => {
    it('all', () => expect(initiativeKeys.all).toEqual(['initiatives']));
    it('kanban', () => expect(initiativeKeys.kanban()).toEqual(['initiatives', 'kanban']));
    it('detail', () => expect(initiativeKeys.detail('i-1')).toEqual(['initiatives', 'detail', 'i-1']));
    it('relations', () =>
      expect(initiativeKeys.relations('i-1')).toEqual(['initiatives', 'detail', 'i-1', 'relations']));
    it('byOrgUnit', () => expect(initiativeKeys.byOrgUnit('ou-1')).toEqual(['initiatives', 'orgUnit', 'ou-1']));
    it('byStrategy', () => expect(initiativeKeys.byStrategy('s-1')).toEqual(['initiatives', 'strategy', 's-1']));
    it('lists', () => expect(initiativeKeys.lists()).toEqual(['initiatives', 'list']));
    it('list', () =>
      expect(initiativeKeys.list({ status: 'active' })).toEqual(['initiatives', 'list', { status: 'active' }]));
    it('details', () => expect(initiativeKeys.details()).toEqual(['initiatives', 'detail']));
  });

  describe('painPointKeys', () => {
    it('all', () => expect(painPointKeys.all).toEqual(['painPoints']));
    it('detail', () => expect(painPointKeys.detail('pp-1')).toEqual(['painPoints', 'detail', 'pp-1']));
    it('relations', () =>
      expect(painPointKeys.relations('pp-1')).toEqual(['painPoints', 'detail', 'pp-1', 'relations']));
    it('byOrgUnit', () => expect(painPointKeys.byOrgUnit('ou-1')).toEqual(['painPoints', 'orgUnit', 'ou-1']));
    it('byCategory', () => expect(painPointKeys.byCategory('ux')).toEqual(['painPoints', 'category', 'ux']));
    it('lists', () => expect(painPointKeys.lists()).toEqual(['painPoints', 'list']));
    it('list', () =>
      expect(painPointKeys.list({ severity: 'high' })).toEqual(['painPoints', 'list', { severity: 'high' }]));
    it('details', () => expect(painPointKeys.details()).toEqual(['painPoints', 'detail']));
  });

  describe('proposedRelationKeys', () => {
    it('all', () => expect(proposedRelationKeys.all).toEqual(['proposedRelations']));
    it('pending', () => expect(proposedRelationKeys.pending()).toEqual(['proposedRelations', 'pending']));
    it('pendingCount', () =>
      expect(proposedRelationKeys.pendingCount()).toEqual(['proposedRelations', 'pending', 'count']));
    it('detail', () => expect(proposedRelationKeys.detail('pr-1')).toEqual(['proposedRelations', 'detail', 'pr-1']));
    it('byEntity', () => expect(proposedRelationKeys.byEntity('e-1')).toEqual(['proposedRelations', 'entity', 'e-1']));
    it('byRunId', () => expect(proposedRelationKeys.byRunId('run-1')).toEqual(['proposedRelations', 'run', 'run-1']));
    it('paginated', () =>
      expect(proposedRelationKeys.paginated('cursor', 10)).toEqual(['proposedRelations', 'paginated', 'cursor', 10]));
    it('lists', () => expect(proposedRelationKeys.lists()).toEqual(['proposedRelations', 'list']));
    it('list', () =>
      expect(proposedRelationKeys.list({ status: 'pending' })).toEqual([
        'proposedRelations',
        'list',
        { status: 'pending' },
      ]));
    it('details', () => expect(proposedRelationKeys.details()).toEqual(['proposedRelations', 'detail']));
  });

  describe('linkerMetricsKeys', () => {
    it('all', () => expect(linkerMetricsKeys.all).toEqual(['linkerMetrics']));
    it('detail', () => expect(linkerMetricsKeys.detail('run-1')).toEqual(['linkerMetrics', 'detail', 'run-1']));
    it('summary', () =>
      expect(linkerMetricsKeys.summary('2026-W08')).toEqual(['linkerMetrics', 'summary', '2026-W08']));
    it('current', () => expect(linkerMetricsKeys.current()).toEqual(['linkerMetrics', 'current']));
    it('lists', () => expect(linkerMetricsKeys.lists()).toEqual(['linkerMetrics', 'list']));
    it('list', () =>
      expect(linkerMetricsKeys.list({ promptVersion: 'v2' })).toEqual([
        'linkerMetrics',
        'list',
        { promptVersion: 'v2' },
      ]));
    it('details', () => expect(linkerMetricsKeys.details()).toEqual(['linkerMetrics', 'detail']));
  });
});
