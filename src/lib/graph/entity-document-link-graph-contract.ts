import type { DocumentRelationshipType, TransformationEntityType } from '@/lib/types';

export const DOCUMENT_LINK_ENTITY_LABELS: Record<TransformationEntityType, string> = {
  technology: 'Technology',
  company: 'Company',
  useCase: 'UseCase',
  strategy: 'Strategy',
  prototype: 'Prototype',
  signal: 'Signal',
  org_unit: 'OrgUnit',
  initiative: 'Initiative',
  pain_point: 'PainPoint',
  document: 'Document',
};

export const DOCUMENT_LINK_RELATIONSHIP_TYPES: Record<DocumentRelationshipType, string> = {
  documentation: 'DOCUMENTED_BY',
  case_study: 'HAS_CASE_STUDY',
  technical_spec: 'HAS_TECHNICAL_SPEC',
  research_paper: 'HAS_RESEARCH',
  competitive_intel: 'HAS_COMPETITIVE_INTEL',
  evidence: 'HAS_EVIDENCE',
  pitch_deck: 'HAS_PITCH_DECK',
  contract: 'HAS_CONTRACT',
  other: 'LINKED_TO',
};

export const DOCUMENT_LINK_ENTITY_COLLECTIONS: Record<TransformationEntityType, string> = {
  technology: 'technologies',
  company: 'companies',
  useCase: 'use-cases',
  strategy: 'strategies',
  prototype: 'prototypes',
  signal: 'signals',
  org_unit: 'org-units',
  initiative: 'initiatives',
  pain_point: 'painPoints',
  document: 'documents',
};

export function isDocumentLinkEntityType(value: unknown): value is TransformationEntityType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_LINK_ENTITY_LABELS, value);
}

export function isDocumentRelationshipType(value: unknown): value is DocumentRelationshipType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_LINK_RELATIONSHIP_TYPES, value);
}

