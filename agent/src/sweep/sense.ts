/**
 * SENSE Step — Cypher Detection Queries and Work Queue Builder
 *
 * The first phase of the sweep loop (SENSE -> DECIDE -> ACT -> REFLECT).
 * Runs Cypher queries via MCP to detect graph anomalies and opportunities.
 * Zero tokens — pure Cypher, no LLM calls.
 *
 * This module produces queries and processes results. The caller (sweep loop)
 * is responsible for executing queries via the `executeCypher` MCP tool.
 */

/** A single item in the work queue */
export interface WorkItem {
  type:
    | 'orphan_entity'
    | 'stale_entity'
    | 'incomplete_entity'
    | 'unscored_signal'
    | 'attention_hotspot'
    | 'external_monitoring';
  entityId: string;
  entityType: string;
  entityName: string;
  priority: number; // 0-100, higher = more urgent
  metadata?: Record<string, unknown>;
}

/** Configuration for the SENSE step */
export interface SenseConfig {
  /** How many days before an entity is considered stale */
  staleDays: number;
  /** Maximum items per detection type */
  maxPerType: number;
  /** Priority order for detection types (first = highest priority) */
  priorities: string[];
}

/** Default SENSE configuration */
export const DEFAULT_SENSE_CONFIG: SenseConfig = {
  staleDays: 30,
  maxPerType: 20,
  priorities: ['orphan_signals', 'stale_entities', 'incomplete_entities', 'missing_relations', 'gap_discovery'],
};

/** A Cypher detection query with its type */
export interface DetectionQuery {
  type: WorkItem['type'];
  cypher: string;
  description: string;
}

/** Result from executing a detection query via MCP */
export interface DetectionResult {
  type: WorkItem['type'];
  records: Array<{
    entityId: string;
    entityType: string;
    entityName: string;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Mapping from priority names (used in config) to detection types (used in queries).
 * Exported for testability.
 */
export const PRIORITY_TYPE_MAP: Record<string, WorkItem['type']> = {
  orphan_signals: 'unscored_signal',
  missing_relations: 'orphan_entity',
  stale_entities: 'stale_entity',
  incomplete_entities: 'incomplete_entity',
  gap_discovery: 'attention_hotspot',
};

/**
 * Generate all detection queries for the SENSE step.
 * These queries are meant to be executed via the `executeCypher` MCP tool.
 */
export function generateDetectionQueries(config?: Partial<SenseConfig>): DetectionQuery[] {
  const cfg: SenseConfig = { ...DEFAULT_SENSE_CONFIG, ...config };

  return [
    {
      type: 'orphan_entity',
      description: 'Entities with zero relationships',
      cypher: `MATCH (n) WHERE NOT (n)--() AND n:Technology OR n:Company OR n:Signal OR n:UseCase OR n:Prototype RETURN n.id AS entityId, labels(n)[0] AS entityType, n.name AS entityName LIMIT ${cfg.maxPerType}`,
    },
    {
      type: 'stale_entity',
      description: `Entities not updated in ${cfg.staleDays} days`,
      cypher: `MATCH (n) WHERE n.updatedAt < datetime() - duration('P${cfg.staleDays}D') AND (n:Technology OR n:Company OR n:Signal) RETURN n.id AS entityId, labels(n)[0] AS entityType, n.name AS entityName, n.updatedAt AS lastUpdated ORDER BY n.updatedAt ASC LIMIT ${cfg.maxPerType}`,
    },
    {
      type: 'incomplete_entity',
      description: 'Entities missing required fields',
      cypher: `MATCH (n:Technology) WHERE n.description IS NULL OR n.description = '' OR n.status IS NULL RETURN n.id AS entityId, 'Technology' AS entityType, n.name AS entityName, 'missing_description_or_status' AS reason LIMIT ${cfg.maxPerType} UNION MATCH (n:Company) WHERE n.description IS NULL OR n.description = '' OR n.website IS NULL RETURN n.id AS entityId, 'Company' AS entityType, n.name AS entityName, 'missing_description_or_website' AS reason LIMIT ${cfg.maxPerType}`,
    },
    {
      type: 'unscored_signal',
      description: 'Signals without evaluation scores',
      cypher: `MATCH (s:Signal) WHERE s.score IS NULL AND s.status = 'detected' RETURN s.id AS entityId, 'Signal' AS entityType, s.title AS entityName ORDER BY s.createdAt DESC LIMIT ${cfg.maxPerType}`,
    },
    {
      type: 'attention_hotspot',
      description: 'Entities with many recent session interactions',
      cypher: `MATCH (n)-[r:CONSUMED|SEARCHED|RELEVANT_TO]-(s:Session) WHERE s.createdAt > datetime() - duration('P7D') WITH n, count(r) AS interactions WHERE interactions >= 3 RETURN n.id AS entityId, labels(n)[0] AS entityType, n.name AS entityName, interactions ORDER BY interactions DESC LIMIT ${cfg.maxPerType}`,
    },
  ];
}

/**
 * Process detection results into a prioritized work queue.
 *
 * Priority is assigned based on:
 * 1. Position in the priorities array (first = highest base priority)
 * 2. Within a type, earlier records get slightly higher priority
 */
export function buildWorkQueue(results: DetectionResult[], config?: Partial<SenseConfig>): WorkItem[] {
  const cfg: SenseConfig = { ...DEFAULT_SENSE_CONFIG, ...config };
  const items: WorkItem[] = [];

  for (const result of results) {
    // Find this type's priority rank via reverse lookup
    const priorityEntry = Object.entries(PRIORITY_TYPE_MAP).find(([, type]) => type === result.type);
    const priorityName = priorityEntry?.[0];
    const priorityIndex = priorityName !== undefined ? cfg.priorities.indexOf(priorityName) : -1;
    const basePriority = priorityIndex >= 0 ? 100 - priorityIndex * 20 : 50;

    for (let i = 0; i < result.records.length; i++) {
      const record = result.records[i];
      items.push({
        type: result.type,
        entityId: record.entityId,
        entityType: record.entityType,
        entityName: record.entityName,
        priority: Math.max(0, basePriority - i),
        metadata: record.metadata,
      });
    }
  }

  // Sort by priority descending
  return items.sort((a, b) => b.priority - a.priority);
}
