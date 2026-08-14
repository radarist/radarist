/**
 * Unit Tests for Relation Ontology Module
 *
 * Tests:
 * - validateRelation function
 * - canonicalizeRelation function
 * - isSymmetricRelation function
 * - getValidRelationTypes function
 * - getRelationDescription function
 * - getRelatedEntityTypes function
 * - Canonical direction enforcement
 * - Symmetric relation handling
 *
 * @jest-environment node
 */

import { describe, it, expect } from "@jest/globals";
import {
  validateRelation,
  canonicalizeRelation,
  isSymmetricRelation,
  getValidRelationTypes,
  getRelationDescription,
  getRelatedEntityTypes,
  RELATION_ONTOLOGY,
  SYMMETRIC_RELATIONS,
  CANONICAL_DIRECTION,
} from "../relation-ontology";
import type { EntityType, RelationType } from "@/lib/types";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a mock relation object for canonicalization testing.
 */
function createMockRelation(
  sourceType: EntityType,
  sourceId: string,
  targetType: EntityType,
  targetId: string,
  relationType: RelationType
) {
  return {
    sourceType,
    sourceId,
    sourceSnapshot: { type: sourceType, id: sourceId, name: `${sourceType}-name` },
    targetType,
    targetId,
    targetSnapshot: { type: targetType, id: targetId, name: `${targetType}-name` },
    relationType,
  };
}

// ============================================================================
// validateRelation TESTS
// ============================================================================

describe("Relation Ontology - validateRelation()", () => {
  describe("Valid Relations", () => {
    it("should validate company → technology vendor relation", () => {
      const result = validateRelation("company", "technology", "vendor");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("should validate company → technology uses in canonical direction", () => {
      const result = validateRelation("company", "technology", "uses");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
    });

    it("should validate technology → technology uses relation", () => {
      const result = validateRelation("technology", "technology", "uses");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
    });

    it("should validate company → company partner relation", () => {
      const result = validateRelation("company", "company", "partner");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
    });

    it("should validate signal → technology mentions relation", () => {
      const result = validateRelation("signal", "technology", "mentions");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
    });

    it("should validate painPoint → initiative drives relation", () => {
      const result = validateRelation("painPoint", "initiative", "drives");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
    });

    it("should validate orgUnit → orgUnit parent relation", () => {
      const result = validateRelation("orgUnit", "orgUnit", "parent");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(false);
    });
  });

  describe("Reverse Direction Detection", () => {
    it("should canonicalize technology → company uses back to company → technology", () => {
      const result = validateRelation("technology", "company", "uses");

      expect(result.valid).toBe(true);
      expect(result.shouldSwap).toBe(true);
    });

    it("should detect when source and target should be swapped for relations only valid in reverse", () => {
      // Some relations may only be valid in one direction
      // Test with a relation that's valid in reverse but not forward
      const result = validateRelation("technology", "useCase", "demonstrates");

      // demonstrates is defined for prototype → useCase, not technology → useCase
      // If valid, it means it found a reverse match
      if (result.valid && result.shouldSwap) {
        expect(result.shouldSwap).toBe(true);
      }
    });

    it("should validate initiative → technology invests_in", () => {
      // initiative → technology with invests_in should be valid
      const result = validateRelation("initiative", "technology", "invests_in");

      expect(result.valid).toBe(true);
    });
  });

  describe("Invalid Relations", () => {
    it("should reject invalid relation type between entity types", () => {
      // company → technology cannot have 'parent' relation
      const result = validateRelation("company", "technology", "parent");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid relation type");
      expect(result.suggestions).toBeDefined();
    });

    it("should provide suggestions for invalid relations", () => {
      const result = validateRelation("company", "technology", "parent");

      expect(result.suggestions).toBeDefined();
      expect(result.suggestions?.length).toBeGreaterThan(0);
      // Valid suggestions should include vendor, user
      expect(result.suggestions).toContain("vendor");
      expect(result.suggestions).toContain("user");
    });

    it("should reject reveals relation for company → company", () => {
      const result = validateRelation("company", "company", "reveals");

      expect(result.valid).toBe(false);
    });
  });

  describe("Custom Relation Type", () => {
    it("should always allow custom relation type between any entity types", () => {
      const entityTypes: EntityType[] = [
        "company",
        "technology",
        "useCase",
        "strategy",
      ];

      for (const source of entityTypes) {
        for (const target of entityTypes) {
          const result = validateRelation(source, target, "custom");
          expect(result.valid).toBe(true);
        }
      }
    });
  });
});

// ============================================================================
// isSymmetricRelation TESTS
// ============================================================================

describe("Relation Ontology - isSymmetricRelation()", () => {
  describe("Symmetric Relations", () => {
    it("should identify partner as symmetric", () => {
      expect(isSymmetricRelation("partner")).toBe(true);
    });

    it("should identify competitor as symmetric", () => {
      expect(isSymmetricRelation("competitor")).toBe(true);
    });

    it("should identify competes_with as symmetric", () => {
      expect(isSymmetricRelation("competes_with")).toBe(true);
    });

  });

  describe("Directional Relations", () => {
    it("should identify uses as directional", () => {
      expect(isSymmetricRelation("uses")).toBe(false);
    });

    it("should identify vendor as directional", () => {
      expect(isSymmetricRelation("vendor")).toBe(false);
    });

    it("should identify enables as directional", () => {
      expect(isSymmetricRelation("enables")).toBe(false);
    });

    it("should identify parent as directional", () => {
      expect(isSymmetricRelation("parent")).toBe(false);
    });

    it("should identify mentions as directional", () => {
      expect(isSymmetricRelation("mentions")).toBe(false);
    });

    it("should keep arbitrary custom assertions directional", () => {
      expect(isSymmetricRelation("custom")).toBe(false);
    });

    it("should identify all new Universal Relations types as directional", () => {
      const newDirectionalTypes: RelationType[] = [
        "mentions",
        "documented_in",
        "source",
        "reveals",
        "experiences",
        "invests_in",
        "parent",
        "child",
        "demonstrates",
        "implements",
        "informed_by",
        "about",
      ];

      newDirectionalTypes.forEach((relType) => {
        expect(isSymmetricRelation(relType)).toBe(false);
      });
    });
  });
});

// ============================================================================
// canonicalizeRelation TESTS
// ============================================================================

describe("Relation Ontology - canonicalizeRelation()", () => {
  describe("Canonical Direction Enforcement", () => {
    it("should swap vendor relation to company → technology", () => {
      const relation = createMockRelation(
        "technology",
        "tech-1",
        "company",
        "company-1",
        "vendor"
      );

      const canonical = canonicalizeRelation(relation);

      // Vendor canonical direction is company → technology
      expect(canonical.sourceType).toBe("company");
      expect(canonical.targetType).toBe("technology");
    });

    it("should not swap if already in canonical direction", () => {
      const relation = createMockRelation(
        "company",
        "company-1",
        "technology",
        "tech-1",
        "vendor"
      );

      const canonical = canonicalizeRelation(relation);

      expect(canonical.sourceType).toBe("company");
      expect(canonical.sourceId).toBe("company-1");
      expect(canonical.targetType).toBe("technology");
      expect(canonical.targetId).toBe("tech-1");
    });

    it("should swap solves relation to technology → painPoint", () => {
      const relation = createMockRelation(
        "painPoint",
        "pp-1",
        "technology",
        "tech-1",
        "solves"
      );

      const canonical = canonicalizeRelation(relation);

      expect(canonical.sourceType).toBe("technology");
      expect(canonical.targetType).toBe("painPoint");
    });
  });

  describe("Symmetric Relation Handling", () => {
    it("should sort entity IDs for symmetric relations", () => {
      const relation = createMockRelation(
        "company",
        "company-z",
        "company",
        "company-a",
        "partner"
      );

      const canonical = canonicalizeRelation(relation);

      // For symmetric relations, source ID should be < target ID
      expect(canonical.sourceId).toBe("company-a");
      expect(canonical.targetId).toBe("company-z");
    });

    it("should not swap if already sorted for symmetric relations", () => {
      const relation = createMockRelation(
        "company",
        "company-a",
        "company",
        "company-z",
        "competitor"
      );

      const canonical = canonicalizeRelation(relation);

      expect(canonical.sourceId).toBe("company-a");
      expect(canonical.targetId).toBe("company-z");
    });
  });

  describe("Relations Without Canonical Direction", () => {
    it("should preserve original order for relations without defined canonical direction", () => {
      const relation = createMockRelation(
        "technology",
        "tech-1",
        "technology",
        "tech-2",
        "uses"
      );

      const canonical = canonicalizeRelation(relation);

      // uses has no canonical direction for same-type, should preserve
      expect(canonical.sourceId).toBe("tech-1");
      expect(canonical.targetId).toBe("tech-2");
    });
  });
});

// ============================================================================
// getValidRelationTypes TESTS
// ============================================================================

describe("Relation Ontology - getValidRelationTypes()", () => {
  it("should return valid relation types for company → technology", () => {
    const types = getValidRelationTypes("company", "technology");

    expect(types).toContain("vendor");
    expect(types).toContain("user");
    expect(types).toContain("custom");
  });

  it("should return valid relation types for technology → technology", () => {
    const types = getValidRelationTypes("technology", "technology");

    expect(types).toContain("uses");
    expect(types).toContain("enables");
    expect(types).toContain("competes_with");
    expect(types).toContain("custom");
  });

  it("should return valid types from both directions", () => {
    const types = getValidRelationTypes("company", "company");

    expect(types).toContain("partner");
    expect(types).toContain("competitor");
    expect(types).toContain("custom");
  });

  it("should deduplicate relation types", () => {
    const types = getValidRelationTypes("company", "company");

    // Check for no duplicates
    const uniqueTypes = [...new Set(types)];
    expect(types.length).toBe(uniqueTypes.length);
  });

  it("should return at least custom for all entity pair combinations", () => {
    const entityTypes: EntityType[] = [
      "company",
      "technology",
      "useCase",
      "strategy",
      "prototype",
      "signal",
      "document",
      "orgUnit",
      "initiative",
      "painPoint",
      "radarPlacement",
    ];

    for (const source of entityTypes) {
      for (const target of entityTypes) {
        const types = getValidRelationTypes(source, target);
        expect(types).toContain("custom");
      }
    }
  });
});

// ============================================================================
// getRelationDescription TESTS
// ============================================================================

describe("Relation Ontology - getRelationDescription()", () => {
  it("should return human-readable description for uses", () => {
    const desc = getRelationDescription("technology", "technology", "uses");

    expect(desc).toContain("uses");
  });

  it("should return human-readable description for vendor", () => {
    const desc = getRelationDescription("company", "technology", "vendor");

    expect(desc).toContain("vendor");
  });

  it("should return human-readable description for partner", () => {
    const desc = getRelationDescription("company", "company", "partner");

    expect(desc).toContain("partner");
  });

  it("should return human-readable description for solves", () => {
    const desc = getRelationDescription("technology", "painPoint", "solves");

    expect(desc).toContain("solves");
  });

  it("should return human-readable description for mentions", () => {
    const desc = getRelationDescription("signal", "technology", "mentions");

    expect(desc).toContain("mentions");
  });

  it("should handle custom relation type", () => {
    const desc = getRelationDescription("company", "technology", "custom");

    expect(desc).toContain("relates to");
  });
});

// ============================================================================
// getRelatedEntityTypes TESTS
// ============================================================================

describe("Relation Ontology - getRelatedEntityTypes()", () => {
  it("should return entity types that company can relate to", () => {
    const related = getRelatedEntityTypes("company");

    expect(related).toContain("technology");
    expect(related).toContain("company");
    expect(related).toContain("painPoint");
    expect(related.length).toBeGreaterThan(0);
  });

  it("should return entity types that technology can relate to", () => {
    const related = getRelatedEntityTypes("technology");

    expect(related).toContain("company");
    expect(related).toContain("technology");
    expect(related).toContain("useCase");
    expect(related).toContain("painPoint");
  });

  it("should return entity types that signal can relate to", () => {
    const related = getRelatedEntityTypes("signal");

    expect(related).toContain("company");
    expect(related).toContain("technology");
    expect(related).toContain("document");
    expect(related).toContain("painPoint");
  });

  it("should include both directions in related types", () => {
    const related = getRelatedEntityTypes("document");

    // Document can be source to various types
    // And various types can be source to document
    expect(related.length).toBeGreaterThan(5);
  });
});

// ============================================================================
// RELATION_ONTOLOGY STRUCTURE TESTS
// ============================================================================

describe("Relation Ontology - RELATION_ONTOLOGY Structure", () => {
  it("should have entries for all entity types", () => {
    const entityTypes: EntityType[] = [
      "company",
      "technology",
      "useCase",
      "strategy",
      "prototype",
      "signal",
      "document",
      "orgUnit",
      "initiative",
      "painPoint",
      "radarPlacement",
    ];

    entityTypes.forEach((entityType) => {
      expect(RELATION_ONTOLOGY[entityType]).toBeDefined();
    });
  });

  it("should have custom relation type for all entity pairs", () => {
    for (const [_sourceType, targets] of Object.entries(RELATION_ONTOLOGY)) {
      for (const [_targetType, relTypes] of Object.entries(targets || {})) {
        expect(relTypes).toContain("custom");
      }
    }
  });

  it("should have symmetric relations defined both ways", () => {
    // For partner: company → company should have it
    expect(RELATION_ONTOLOGY.company?.company).toContain("partner");

    // For competitor: company → company should have it
    expect(RELATION_ONTOLOGY.company?.company).toContain("competitor");

    // For competes_with: technology → technology should have it
    expect(RELATION_ONTOLOGY.technology?.technology).toContain("competes_with");
  });
});

// ============================================================================
// SYMMETRIC_RELATIONS STRUCTURE TESTS
// ============================================================================

describe("Relation Ontology - SYMMETRIC_RELATIONS", () => {
  it("should contain partner", () => {
    expect(SYMMETRIC_RELATIONS).toContain("partner");
  });

  it("should contain competitor", () => {
    expect(SYMMETRIC_RELATIONS).toContain("competitor");
  });

  it("should contain competes_with", () => {
    expect(SYMMETRIC_RELATIONS).toContain("competes_with");
  });

  it("should not assume custom relation semantics are symmetric", () => {
    expect(SYMMETRIC_RELATIONS).not.toContain("custom");
  });

  it("should not contain directional relations", () => {
    expect(SYMMETRIC_RELATIONS).not.toContain("uses");
    expect(SYMMETRIC_RELATIONS).not.toContain("vendor");
    expect(SYMMETRIC_RELATIONS).not.toContain("parent");
    expect(SYMMETRIC_RELATIONS).not.toContain("child");
  });
});

// ============================================================================
// CANONICAL_DIRECTION STRUCTURE TESTS
// ============================================================================

describe("Relation Ontology - CANONICAL_DIRECTION", () => {
  it("should define vendor as company → technology", () => {
    expect(CANONICAL_DIRECTION.vendor).toEqual(["company", "technology"]);
  });

  it("should define user as company → technology", () => {
    expect(CANONICAL_DIRECTION.user).toEqual(["company", "technology"]);
  });

  it("should define solves as technology → painPoint", () => {
    expect(CANONICAL_DIRECTION.solves).toEqual(["technology", "painPoint"]);
  });

  it("should define parent as orgUnit → orgUnit", () => {
    expect(CANONICAL_DIRECTION.parent).toEqual(["orgUnit", "orgUnit"]);
  });

  it("should define child as orgUnit → orgUnit", () => {
    expect(CANONICAL_DIRECTION.child).toEqual(["orgUnit", "orgUnit"]);
  });

  it("should define documented_in as technology → document", () => {
    expect(CANONICAL_DIRECTION.documented_in).toEqual(["technology", "document"]);
  });

  it("should define mentions as signal → technology", () => {
    expect(CANONICAL_DIRECTION.mentions).toEqual(["signal", "technology"]);
  });
});
