/**
 * @file company-relationships.ts
 * @description Data access layer for Company-Blip Relationships in the Scouting feature.
 * 
 * This module manages the many-to-many relationships between companies and radar entries (blips).
 * Each relationship can have metadata including type, notes, and linked use cases.
 * 
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db, removeUndefinedFields } from "@/lib/firebase";
import {
    collection,
    doc,
    getDocs,
    getDoc,
    setDoc,
    deleteDoc,
    updateDoc,
    query,
    where,
} from "firebase/firestore";
import type { CompanyBlipRelationship, RelationshipType } from "@/lib/types";

/**
 * Creates a relationship between a company and a radar blip.
 * This establishes that the company has some connection to the technology.
 * 
 * @param companyId - The ID of the company
 * @param radarId - The ID of the radar containing the blip
 * @param radarEntryId - The numeric ID of the radar entry (blip)
 * @param relationshipType - The type of relationship (Vendor, User, Partner, Competitor)
 * @param notes - Optional notes about the relationship
 * @param useCaseIds - Optional array of use case IDs this relationship addresses
 * @returns Promise resolving to the newly created relationship
 * @throws Error if Firestore operation fails
 * 
 * @example
 * // Link Datadog as a vendor for our monitoring blip
 * const relationship = await linkCompanyToBlip(
 *   "datadog-123",
 *   "tech-radar-2024",
 *   42,
 *   "Vendor",
 *   "Provides APM and monitoring solutions",
 *   ["monitoring-use-case-456"]
 * );
 */
export async function linkCompanyToBlip(
    companyId: string,
    radarId: string,
    radarEntryId: number,
    relationshipType: RelationshipType,
    notes: string = "",
    useCaseIds: string[] = []
): Promise<CompanyBlipRelationship> {
    // Generate a unique ID for the relationship
    const id = `${companyId}-${radarId}-${radarEntryId}-${Date.now()}`;
    const now = Date.now();

    const relationship: CompanyBlipRelationship = {
        id,
        companyId,
        radarId,
        radarEntryId,
        relationshipType,
        notes,
        useCaseIds,
        createdAt: now,
        updatedAt: now,
    };

    // Uses setDoc directly (not entity-factory) — join-table record without slug or uniqueness constraints.
    await setDoc(doc(db, "company-blip-relationships", id), relationship);
    return relationship;
}

/**
 * Removes the relationship between a company and a radar blip.
 * 
 * Note: This requires knowing the exact relationship ID. Use getRelationshipId()
 * if you only have companyId and radarEntryId.
 * 
 * @param relationshipId - The ID of the relationship to remove
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await unlinkCompanyFromBlip("datadog-123-tech-radar-2024-42-1234567890");
 */
export async function unlinkCompanyFromBlip(relationshipId: string): Promise<void> {
    await deleteDoc(doc(db, "company-blip-relationships", relationshipId));
}

/**
 * Removes all relationships between a company and a specific blip.
 * This is useful when you don't have the exact relationship ID.
 * 
 * @param companyId - The ID of the company
 * @param radarId - The ID of the radar
 * @param radarEntryId - The numeric ID of the radar entry
 * @returns Promise that resolves to the number of relationships deleted
 * @throws Error if Firestore operation fails
 * 
 * @example
 * const count = await unlinkCompanyFromBlipByIds("datadog-123", "tech-radar-2024", 42);
 * console.log(`Removed ${count} relationships`);
 */
export async function unlinkCompanyFromBlipByIds(
    companyId: string,
    radarId: string,
    radarEntryId: number
): Promise<number> {
    const relationships = await getRelationshipsByCompanyAndBlip(
        companyId,
        radarId,
        radarEntryId
    );

    await Promise.all(
        relationships.map(rel => unlinkCompanyFromBlip(rel.id))
    );

    return relationships.length;
}

/**
 * Updates an existing company-blip relationship.
 * Automatically updates the updatedAt timestamp.
 * 
 * @param relationshipId - The ID of the relationship to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await updateRelationship("rel-123", {
 *   relationshipType: "Partner",
 *   notes: "Now a strategic partner",
 *   useCaseIds: ["monitoring-456", "security-789"]
 * });
 */
export async function updateRelationship(
    relationshipId: string,
    updates: Partial<Omit<CompanyBlipRelationship, "id" | "companyId" | "radarId" | "radarEntryId" | "createdAt">>
): Promise<void> {
    const docRef = doc(db, "company-blip-relationships", relationshipId);
    // Remove undefined values before updating Firestore (Firestore doesn't accept undefined)
    const cleanedUpdates = removeUndefinedFields({
        ...updates,
        updatedAt: Date.now(),
    });
    await updateDoc(docRef, cleanedUpdates);
}

/**
 * Fetches all radar entries (blips) linked to a specific company.
 * Returns the relationship objects, not the actual radar entries.
 * 
 * @param companyId - The ID of the company
 * @returns Promise resolving to an array of CompanyBlipRelationship objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const relationships = await getRelationshipsByCompanyId("datadog-123");
 * console.log(`Datadog is linked to ${relationships.length} technologies`);
 * 
 * // Get all vendor relationships
 * const vendorRels = relationships.filter(r => r.relationshipType === "Vendor");
 */
export async function getRelationshipsByCompanyId(
    companyId: string
): Promise<CompanyBlipRelationship[]> {
    const q = query(
        collection(db, "company-blip-relationships"),
        where("companyId", "==", companyId)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as CompanyBlipRelationship);
}

/**
 * Fetches all companies linked to a specific radar blip.
 * Returns the relationship objects, not the actual company data.
 * 
 * @param radarId - The ID of the radar
 * @param radarEntryId - The numeric ID of the radar entry
 * @returns Promise resolving to an array of CompanyBlipRelationship objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const relationships = await getRelationshipsByBlipId("tech-radar-2024", 42);
 * console.log(`${relationships.length} companies are linked to this technology`);
 * 
 * // Get all companies that are users of this technology
 * const users = relationships.filter(r => r.relationshipType === "User");
 */
export async function getRelationshipsByBlipId(
    radarId: string,
    radarEntryId: number
): Promise<CompanyBlipRelationship[]> {
    const q = query(
        collection(db, "company-blip-relationships"),
        where("radarId", "==", radarId),
        where("radarEntryId", "==", radarEntryId)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as CompanyBlipRelationship);
}

/**
 * Fetches specific relationships between a company and a blip.
 * Can return multiple relationships if the company has different relationship types
 * with the same technology (e.g., both User and Competitor).
 * 
 * @param companyId - The ID of the company
 * @param radarId - The ID of the radar
 * @param radarEntryId - The numeric ID of the radar entry
 * @returns Promise resolving to an array of matching relationships
 * @throws Error if Firestore query fails
 * 
 * @example
 * const rels = await getRelationshipsByCompanyAndBlip("datadog-123", "tech-radar-2024", 42);
 * if (rels.length > 0) {
 *   console.log(`Found ${rels.length} relationships`);
 * }
 */
export async function getRelationshipsByCompanyAndBlip(
    companyId: string,
    radarId: string,
    radarEntryId: number
): Promise<CompanyBlipRelationship[]> {
    const q = query(
        collection(db, "company-blip-relationships"),
        where("companyId", "==", companyId),
        where("radarId", "==", radarId),
        where("radarEntryId", "==", radarEntryId)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as CompanyBlipRelationship);
}

/**
 * Fetches a single relationship by its ID.
 * 
 * @param relationshipId - The ID of the relationship
 * @returns Promise resolving to the relationship or null if not found
 * @throws Error if Firestore query fails
 * 
 * @example
 * const rel = await getRelationshipById("rel-123");
 * if (rel) {
 *   console.log(`Type: ${rel.relationshipType}, Notes: ${rel.notes}`);
 * }
 */
export async function getRelationshipById(
    relationshipId: string
): Promise<CompanyBlipRelationship | null> {
    const docRef = doc(db, "company-blip-relationships", relationshipId);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
        return docSnap.data() as CompanyBlipRelationship;
    }
    return null;
}

/**
 * Fetches all relationships for a specific radar.
 * Useful for getting a complete view of company connections within a radar.
 * 
 * @param radarId - The ID of the radar
 * @returns Promise resolving to an array of CompanyBlipRelationship objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const relationships = await getRelationshipsByRadarId("tech-radar-2024");
 * console.log(`${relationships.length} total company-technology connections`);
 */
export async function getRelationshipsByRadarId(
    radarId: string
): Promise<CompanyBlipRelationship[]> {
    const q = query(
        collection(db, "company-blip-relationships"),
        where("radarId", "==", radarId)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as CompanyBlipRelationship);
}

/**
 * Checks if a specific relationship exists between a company and a blip.
 * 
 * @param companyId - The ID of the company
 * @param radarId - The ID of the radar
 * @param radarEntryId - The numeric ID of the radar entry
 * @param relationshipType - Optional: specific relationship type to check
 * @returns Promise resolving to true if relationship exists, false otherwise
 * @throws Error if Firestore query fails
 * 
 * @example
 * const isVendor = await relationshipExists(
 *   "datadog-123",
 *   "tech-radar-2024",
 *   42,
 *   "Vendor"
 * );
 * 
 * if (isVendor) {
 *   console.log("Datadog is already linked as a vendor");
 * }
 */
export async function relationshipExists(
    companyId: string,
    radarId: string,
    radarEntryId: number,
    relationshipType?: RelationshipType
): Promise<boolean> {
    const relationships = await getRelationshipsByCompanyAndBlip(
        companyId,
        radarId,
        radarEntryId
    );

    if (relationshipType) {
        return relationships.some(rel => rel.relationshipType === relationshipType);
    }

    return relationships.length > 0;
}
