/**
 * @file scouting-constants.ts
 * @description Constants and configuration values for the Scouting feature.
 * 
 * This file contains arrays of options for dropdowns, default values,
 * and other configuration constants used throughout the Scouting feature.
 * 
 * @author Radarist Team
 * @created 2025-11-25
 */

import type {
    CompanyType,
    CompanySize,
    CompanyStage,
    CompanyStatus,
    CompanyIndustry,
    RelationshipType,
    NoteType
} from "@/lib/types";

/**
 * All available company types for multi-select dropdowns.
 * Updated in Phase 4 to use new lowercase snake_case values.
 */
export const COMPANY_TYPES: CompanyType[] = [
    "startup",
    "scaleup",
    "sme",
    "corporate",
    "spinoff",
    "joint_venture",
    "research",
    "accelerator",
    "venture_studio",
    "consultancy",
];

/**
 * All available company sizes for selection.
 * Updated in Phase 4 to use new lowercase values.
 */
export const COMPANY_SIZES: CompanySize[] = [
    "micro",
    "small",
    "medium",
    "large",
    "enterprise",
];

/**
 * All available funding stages for selection.
 * Updated in Phase 4 to use new lowercase snake_case values.
 */
export const COMPANY_STAGES: CompanyStage[] = [
    "pre_seed",
    "seed",
    "series_a",
    "series_b",
    "series_c_plus",
    "bootstrapped",
    "private",
    "public",
    "ipo",
    "nonprofit",
];

/**
 * All available company statuses in workflow order.
 */
export const COMPANY_STATUSES: CompanyStatus[] = [
    "Watching",
    "Contacted",
    "Partner",
    "Rejected",
];

/**
 * All available relationship types between companies and blips.
 */
export const RELATIONSHIP_TYPES: RelationshipType[] = [
    "Vendor",
    "User",
    "Partner",
    "Competitor",
];

/**
 * All available note types for categorization.
 */
export const NOTE_TYPES: NoteType[] = [
    "Meeting",
    "Email",
    "Demo",
    "Evaluation",
    "General",
];

/**
 * Common industry categories.
 * Updated in Phase 4 to use CompanyIndustry enum values.
 */
export const INDUSTRIES: CompanyIndustry[] = [
    "healthcare",
    "food_agriculture",
    "technology",
    "manufacturing",
    "energy",
    "consumer",
    "financial",
    "logistics",
    "media",
    "professional",
    "other",
];

/**
 * Default empty company object for form initialization.
 * Updated in Phase 4 to use new enum values.
 */
export const DEFAULT_COMPANY = {
    name: "",
    description: "",
    website: "",
    type: [] as CompanyType[],
    industry: [] as CompanyIndustry[],
    size: "small" as CompanySize,
    stage: "seed" as CompanyStage,
    location: { city: "", country: "" },
    status: "Watching" as CompanyStatus,
    tags: [] as string[],
    socialLinks: {},
    technologyStack: [] as string[],
    documents: [],
};

/**
 * Default empty contact object for form initialization.
 */
export const DEFAULT_CONTACT = {
    name: "",
    role: "",
    email: "",
    phone: "",
    linkedin: "",
    notes: "",
    isPrimary: false,
};

/**
 * Default empty use case object for form initialization.
 */
export const DEFAULT_USE_CASE = {
    name: "",
    description: "",
    category: "",
    linkedBlipIds: [] as string[],
    linkedCompanyIds: [] as string[],
    tags: [] as string[],
};
