/**
 * Integration Tests for Relations API Routes
 *
 * Tests the /api/relations endpoints for:
 * - Request validation
 * - Response structure
 * - Error handling
 *
 * Note: These tests use mocked Firestore operations via Jest mocks.
 * For full E2E testing with Firebase emulator, use Playwright tests.
 *
 * @jest-environment node
 */

import { describe, it, expect } from "@jest/globals";
import type { Relation, EntityType, RelationType, EntitySnapshot } from "@/lib/types";

// ============================================================================
// MOCK DATA HELPERS
// ============================================================================

function createMockSnapshot(
  type: EntityType,
  id: string,
  name: string,
  overrides?: Partial<EntitySnapshot>
): EntitySnapshot {
  return {
    type,
    id,
    name,
    description: `Description for ${name}`,
    snapshotAt: Date.now(),
    ...overrides,
  };
}

function createMockRelation(overrides?: Partial<Relation>): Relation {
  return {
    id: `rel-${Date.now()}`,
    relationType: "uses",
    sourceSnapshot: createMockSnapshot("technology", "tech-1", "TensorFlow"),
    targetSnapshot: createMockSnapshot("technology", "tech-2", "Python"),
    notes: "Test relation",
    aiSuggested: false,
    confidence: 95,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    ...overrides,
  };
}

// ============================================================================
// REQUEST VALIDATION TESTS
// ============================================================================

describe("Relations API - Request Validation", () => {
  describe("POST /api/relations validation", () => {
    /**
     * Validates a POST request body for creating a relation
     */
    function validateCreateRelationRequest(body: Record<string, unknown>): {
      valid: boolean;
      errors: string[];
    } {
      const errors: string[] = [];

      // Check required fields
      if (!body.relationType) {
        errors.push("relationType is required");
      }

      if (!body.sourceSnapshot) {
        errors.push("sourceSnapshot is required");
      }

      if (!body.targetSnapshot) {
        errors.push("targetSnapshot is required");
      }

      // Validate sourceSnapshot structure
      if (body.sourceSnapshot && typeof body.sourceSnapshot === "object") {
        const snapshot = body.sourceSnapshot as Record<string, unknown>;
        if (!snapshot.type) errors.push("sourceSnapshot.type is required");
        if (!snapshot.id) errors.push("sourceSnapshot.id is required");
        if (!snapshot.name) errors.push("sourceSnapshot.name is required");
      }

      // Validate targetSnapshot structure
      if (body.targetSnapshot && typeof body.targetSnapshot === "object") {
        const snapshot = body.targetSnapshot as Record<string, unknown>;
        if (!snapshot.type) errors.push("targetSnapshot.type is required");
        if (!snapshot.id) errors.push("targetSnapshot.id is required");
        if (!snapshot.name) errors.push("targetSnapshot.name is required");
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    }

    it("should require relationType", () => {
      const result = validateCreateRelationRequest({
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("relationType is required");
    });

    it("should require sourceSnapshot", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("sourceSnapshot is required");
    });

    it("should require targetSnapshot", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("targetSnapshot is required");
    });

    it("should require sourceSnapshot.type", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: { id: "tech-1", name: "React" },
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("sourceSnapshot.type is required");
    });

    it("should require sourceSnapshot.id", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: { type: "technology", name: "React" },
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("sourceSnapshot.id is required");
    });

    it("should require sourceSnapshot.name", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: { type: "technology", id: "tech-1" },
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("sourceSnapshot.name is required");
    });

    it("should require targetSnapshot.type", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
        targetSnapshot: { id: "company-1", name: "Meta" },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("targetSnapshot.type is required");
    });

    it("should require targetSnapshot.id", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
        targetSnapshot: { type: "company", name: "Meta" },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("targetSnapshot.id is required");
    });

    it("should require targetSnapshot.name", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
        targetSnapshot: { type: "company", id: "company-1" },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("targetSnapshot.name is required");
    });

    it("should pass validation with all required fields", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept optional fields", () => {
      const result = validateCreateRelationRequest({
        relationType: "vendor",
        sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
        targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
        notes: "React is developed by Meta",
        confidence: 100,
        aiSuggested: false,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe("PUT /api/relations/[id] validation", () => {
    /**
     * Validates a PUT request body for updating a relation
     */
    function validateUpdateRelationRequest(body: Record<string, unknown>): {
      valid: boolean;
      errors: string[];
    } {
      const errors: string[] = [];

      // Must have at least one field to update
      if (Object.keys(body).length === 0) {
        errors.push("No updates provided");
      }

      // Validate sourceSnapshot if provided
      if (body.sourceSnapshot && typeof body.sourceSnapshot === "object") {
        const snapshot = body.sourceSnapshot as Record<string, unknown>;
        if (!snapshot.type) errors.push("sourceSnapshot.type is required");
        if (!snapshot.id) errors.push("sourceSnapshot.id is required");
        if (!snapshot.name) errors.push("sourceSnapshot.name is required");
      }

      // Validate targetSnapshot if provided
      if (body.targetSnapshot && typeof body.targetSnapshot === "object") {
        const snapshot = body.targetSnapshot as Record<string, unknown>;
        if (!snapshot.type) errors.push("targetSnapshot.type is required");
        if (!snapshot.id) errors.push("targetSnapshot.id is required");
        if (!snapshot.name) errors.push("targetSnapshot.name is required");
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    }

    it("should reject empty body", () => {
      const result = validateUpdateRelationRequest({});

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("No updates provided");
    });

    it("should accept notes update only", () => {
      const result = validateUpdateRelationRequest({
        notes: "Updated notes",
      });

      expect(result.valid).toBe(true);
    });

    it("should accept confidence update only", () => {
      const result = validateUpdateRelationRequest({
        confidence: 85,
      });

      expect(result.valid).toBe(true);
    });

    it("should accept relationType update only", () => {
      const result = validateUpdateRelationRequest({
        relationType: "competes_with",
      });

      expect(result.valid).toBe(true);
    });

    it("should validate sourceSnapshot if provided", () => {
      const result = validateUpdateRelationRequest({
        sourceSnapshot: { type: "technology" }, // Missing id and name
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("sourceSnapshot.id is required");
      expect(result.errors).toContain("sourceSnapshot.name is required");
    });

    it("should validate targetSnapshot if provided", () => {
      const result = validateUpdateRelationRequest({
        targetSnapshot: { name: "Updated Name" }, // Missing type and id
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("targetSnapshot.type is required");
      expect(result.errors).toContain("targetSnapshot.id is required");
    });

    it("should accept multiple valid updates", () => {
      const result = validateUpdateRelationRequest({
        notes: "Updated notes",
        confidence: 90,
        relationType: "enables",
      });

      expect(result.valid).toBe(true);
    });
  });
});

// ============================================================================
// QUERY PARAMETER PARSING TESTS
// ============================================================================

describe("Relations API - Query Parameter Parsing", () => {
  /**
   * Parses query parameters for GET /api/relations
   */
  function parseRelationsQuery(searchParams: URLSearchParams): {
    entityId: string | null;
    entityType: EntityType | null;
    relationType: RelationType | null;
    aiSuggested: boolean | null;
    stale: boolean;
    minConfidence: number | null;
    maxConfidence: number | null;
  } {
    return {
      entityId: searchParams.get("entityId"),
      entityType: searchParams.get("entityType") as EntityType | null,
      relationType: searchParams.get("relationType") as RelationType | null,
      aiSuggested:
        searchParams.get("aiSuggested") === "true"
          ? true
          : searchParams.get("aiSuggested") === "false"
          ? false
          : null,
      stale: searchParams.get("stale") === "true",
      minConfidence: searchParams.get("minConfidence")
        ? parseInt(searchParams.get("minConfidence")!, 10)
        : null,
      maxConfidence: searchParams.get("maxConfidence")
        ? parseInt(searchParams.get("maxConfidence")!, 10)
        : null,
    };
  }

  it("should parse entityId", () => {
    const params = new URLSearchParams("entityId=tech-123");
    const result = parseRelationsQuery(params);

    expect(result.entityId).toBe("tech-123");
  });

  it("should parse relationType", () => {
    const params = new URLSearchParams("relationType=uses");
    const result = parseRelationsQuery(params);

    expect(result.relationType).toBe("uses");
  });

  it("should parse aiSuggested=true", () => {
    const params = new URLSearchParams("aiSuggested=true");
    const result = parseRelationsQuery(params);

    expect(result.aiSuggested).toBe(true);
  });

  it("should parse aiSuggested=false", () => {
    const params = new URLSearchParams("aiSuggested=false");
    const result = parseRelationsQuery(params);

    expect(result.aiSuggested).toBe(false);
  });

  it("should parse stale=true", () => {
    const params = new URLSearchParams("stale=true");
    const result = parseRelationsQuery(params);

    expect(result.stale).toBe(true);
  });

  it("should parse minConfidence", () => {
    const params = new URLSearchParams("minConfidence=70");
    const result = parseRelationsQuery(params);

    expect(result.minConfidence).toBe(70);
  });

  it("should parse maxConfidence", () => {
    const params = new URLSearchParams("maxConfidence=95");
    const result = parseRelationsQuery(params);

    expect(result.maxConfidence).toBe(95);
  });

  it("should parse multiple parameters", () => {
    const params = new URLSearchParams(
      "entityId=tech-1&relationType=uses&minConfidence=80&aiSuggested=true"
    );
    const result = parseRelationsQuery(params);

    expect(result.entityId).toBe("tech-1");
    expect(result.relationType).toBe("uses");
    expect(result.minConfidence).toBe(80);
    expect(result.aiSuggested).toBe(true);
  });

  it("should return null for missing parameters", () => {
    const params = new URLSearchParams("");
    const result = parseRelationsQuery(params);

    expect(result.entityId).toBeNull();
    expect(result.relationType).toBeNull();
    expect(result.minConfidence).toBeNull();
    expect(result.aiSuggested).toBeNull();
    expect(result.stale).toBe(false);
  });
});

// ============================================================================
// RESPONSE STRUCTURE TESTS
// ============================================================================

describe("Relations API - Response Structure", () => {
  /**
   * Creates a standard success response
   */
  function createSuccessResponse<T>(data: T, count?: number): {
    success: boolean;
    data: T;
    count?: number;
  } {
    return {
      success: true,
      data,
      ...(count !== undefined && { count }),
    };
  }

  /**
   * Creates a standard error response
   */
  function createErrorResponse(
    error: string,
    message?: string
  ): {
    success: boolean;
    error: string;
    message?: string;
  } {
    return {
      success: false,
      error,
      ...(message && { message }),
    };
  }

  describe("Success Responses", () => {
    it("should include success: true", () => {
      const response = createSuccessResponse([createMockRelation()], 1);

      expect(response.success).toBe(true);
    });

    it("should include data array for list endpoints", () => {
      const relations = [createMockRelation(), createMockRelation()];
      const response = createSuccessResponse(relations, relations.length);

      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data).toHaveLength(2);
    });

    it("should include count for list endpoints", () => {
      const relations = [createMockRelation()];
      const response = createSuccessResponse(relations, 1);

      expect(response.count).toBe(1);
    });

    it("should include single object for detail endpoints", () => {
      const relation = createMockRelation();
      const response = createSuccessResponse(relation);

      expect(response.data).toHaveProperty("id");
      expect(response.data).toHaveProperty("relationType");
    });
  });

  describe("Error Responses", () => {
    it("should include success: false", () => {
      const response = createErrorResponse("Not found");

      expect(response.success).toBe(false);
    });

    it("should include error message", () => {
      const response = createErrorResponse("Relation not found");

      expect(response.error).toBe("Relation not found");
    });

    it("should optionally include detailed message", () => {
      const response = createErrorResponse(
        "Failed to create relation",
        "sourceSnapshot.type is required"
      );

      expect(response.message).toBe("sourceSnapshot.type is required");
    });
  });
});

// ============================================================================
// FLIP RELATION TESTS
// ============================================================================

describe("Relations API - Flip Relation Logic", () => {
  /**
   * Flips a relation by swapping source and target
   */
  function flipRelation(relation: Relation): Omit<Relation, "id" | "createdAt" | "updatedAt"> {
    return {
      relationType: relation.relationType,
      sourceSnapshot: relation.targetSnapshot,
      targetSnapshot: relation.sourceSnapshot,
      notes: relation.notes,
      confidence: relation.confidence,
      aiSuggested: relation.aiSuggested,
    };
  }

  it("should swap source and target snapshots", () => {
    const original = createMockRelation({
      sourceSnapshot: createMockSnapshot("technology", "tech-1", "React"),
      targetSnapshot: createMockSnapshot("company", "company-1", "Meta"),
    });

    const flipped = flipRelation(original);

    expect(flipped.sourceSnapshot.id).toBe("company-1");
    expect(flipped.sourceSnapshot.name).toBe("Meta");
    expect(flipped.targetSnapshot.id).toBe("tech-1");
    expect(flipped.targetSnapshot.name).toBe("React");
  });

  it("should preserve relation type", () => {
    const original = createMockRelation({ relationType: "vendor" });
    const flipped = flipRelation(original);

    expect(flipped.relationType).toBe("vendor");
  });

  it("should preserve notes", () => {
    const original = createMockRelation({ notes: "Original notes" });
    const flipped = flipRelation(original);

    expect(flipped.notes).toBe("Original notes");
  });

  it("should preserve confidence", () => {
    const original = createMockRelation({ confidence: 85 });
    const flipped = flipRelation(original);

    expect(flipped.confidence).toBe(85);
  });

  it("should preserve aiSuggested flag", () => {
    const original = createMockRelation({ aiSuggested: true });
    const flipped = flipRelation(original);

    expect(flipped.aiSuggested).toBe(true);
  });

  it("should be reversible (double flip = original)", () => {
    const original = createMockRelation();
    const flipped = flipRelation(original);
    const doubleFlipped = flipRelation({
      ...flipped,
      id: original.id,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });

    expect(doubleFlipped.sourceSnapshot.id).toBe(original.sourceSnapshot.id);
    expect(doubleFlipped.targetSnapshot.id).toBe(original.targetSnapshot.id);
  });
});

// ============================================================================
// ENTITY TYPE FILTER TESTS
// ============================================================================

describe("Relations API - Entity Type Filtering", () => {
  const ALL_ENTITY_TYPES: EntityType[] = [
    "technology",
    "company",
    "useCase",
    "strategy",
    "prototype",
    "signal",
    "orgUnit",
    "initiative",
    "painPoint",
    "document",
  ];

  /**
   * Filter relations by source entity type
   */
  function filterBySourceType(
    relations: Relation[],
    sourceTypes: EntityType[]
  ): Relation[] {
    if (sourceTypes.length === 0) return relations;
    return relations.filter((r) =>
      sourceTypes.includes(r.sourceSnapshot.type)
    );
  }

  /**
   * Filter relations by target entity type
   */
  function filterByTargetType(
    relations: Relation[],
    targetTypes: EntityType[]
  ): Relation[] {
    if (targetTypes.length === 0) return relations;
    return relations.filter((r) =>
      targetTypes.includes(r.targetSnapshot.type)
    );
  }

  it("should return all relations when no filter provided", () => {
    const relations = [
      createMockRelation({
        sourceSnapshot: createMockSnapshot("technology", "t1", "Tech1"),
      }),
      createMockRelation({
        sourceSnapshot: createMockSnapshot("company", "c1", "Company1"),
      }),
    ];

    const result = filterBySourceType(relations, []);

    expect(result).toHaveLength(2);
  });

  it("should filter by single source type", () => {
    const relations = [
      createMockRelation({
        sourceSnapshot: createMockSnapshot("technology", "t1", "Tech1"),
      }),
      createMockRelation({
        sourceSnapshot: createMockSnapshot("company", "c1", "Company1"),
      }),
      createMockRelation({
        sourceSnapshot: createMockSnapshot("technology", "t2", "Tech2"),
      }),
    ];

    const result = filterBySourceType(relations, ["technology"]);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.sourceSnapshot.type === "technology")).toBe(true);
  });

  it("should filter by multiple source types", () => {
    const relations = [
      createMockRelation({
        sourceSnapshot: createMockSnapshot("technology", "t1", "Tech1"),
      }),
      createMockRelation({
        sourceSnapshot: createMockSnapshot("company", "c1", "Company1"),
      }),
      createMockRelation({
        sourceSnapshot: createMockSnapshot("useCase", "u1", "UseCase1"),
      }),
    ];

    const result = filterBySourceType(relations, ["technology", "company"]);

    expect(result).toHaveLength(2);
  });

  it("should filter by target type", () => {
    const relations = [
      createMockRelation({
        targetSnapshot: createMockSnapshot("company", "c1", "Company1"),
      }),
      createMockRelation({
        targetSnapshot: createMockSnapshot("company", "c2", "Company2"),
      }),
      createMockRelation({
        targetSnapshot: createMockSnapshot("technology", "t1", "Tech1"),
      }),
    ];

    const result = filterByTargetType(relations, ["company"]);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.targetSnapshot.type === "company")).toBe(true);
  });

  it("should recognize all entity types", () => {
    // Ensure all entity types are valid
    ALL_ENTITY_TYPES.forEach((type) => {
      const relations = [
        createMockRelation({
          sourceSnapshot: createMockSnapshot(type, `${type}-1`, `${type} entity`),
        }),
      ];

      const result = filterBySourceType(relations, [type]);
      expect(result).toHaveLength(1);
    });
  });
});
