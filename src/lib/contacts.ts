/**
 * @file contacts.ts
 * @description Data access layer for Contacts in the Scouting feature.
 * 
 * Contacts represent individual people within companies. Each company can have multiple
 * contacts, and one contact can be designated as the primary contact.
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
} from "firebase/firestore";
import type { Contact } from "@/lib/types";

/**
 * Fetches all contacts for a specific company.
 * Contacts are stored as a subcollection under each company document.
 * 
 * @param companyId - The ID of the parent company
 * @returns Promise resolving to an array of Contact objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const contacts = await getContactsByCompanyId("datadog-123");
 * const primaryContact = contacts.find(c => c.isPrimary);
 * console.log(`Primary contact: ${primaryContact?.name}`);
 */
export async function getContactsByCompanyId(companyId: string): Promise<Contact[]> {
    const contactsRef = collection(db, "companies", companyId, "contacts");
    const querySnapshot = await getDocs(contactsRef);
    return querySnapshot.docs.map(doc => doc.data() as Contact);
}

/**
 * Fetches a single contact by ID.
 * 
 * @param companyId - The ID of the parent company
 * @param contactId - The ID of the contact
 * @returns Promise resolving to the Contact object or null if not found
 * @throws Error if Firestore query fails
 * 
 * @example
 * const contact = await getContactById("datadog-123", "john-doe-456");
 * if (contact) {
 *   console.log(`Email: ${contact.email}`);
 * }
 */
export async function getContactById(
    companyId: string,
    contactId: string
): Promise<Contact | null> {
    const docRef = doc(db, "companies", companyId, "contacts", contactId);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
        return docSnap.data() as Contact;
    }
    return null;
}

/**
 * Creates a new contact for a company.
 * Automatically generates an ID and timestamps.
 * If this is set as the primary contact, it will unset other primary contacts.
 * 
 * @param companyId - The ID of the parent company
 * @param contact - The contact data without system-managed fields
 * @returns Promise resolving to the newly created Contact object
 * @throws Error if Firestore operation fails
 * 
 * @example
 * const newContact = await createContact("datadog-123", {
 *   name: "John Doe",
 *   role: "Sales Engineer",
 *   email: "john.doe@datadog.com",
 *   phone: "+1-555-0123",
 *   linkedin: "https://linkedin.com/in/johndoe",
 *   notes: "Met at conference",
 *   isPrimary: true
 * });
 */
export async function createContact(
    companyId: string,
    contact: Omit<Contact, "id" | "companyId" | "createdAt" | "updatedAt">
): Promise<Contact> {
    // Generate ID from name and timestamp
    const id = contact.name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '') + '-' + Date.now();

    const now = Date.now();

    const newContact: Contact = {
        ...contact,
        id,
        companyId,
        createdAt: now,
        updatedAt: now,
    };

    // If this is being set as primary, unset other primary contacts first
    if (newContact.isPrimary) {
        await unsetAllPrimaryContacts(companyId);
    }

    // Uses setDoc directly (not entity-factory) — subcollection document under parent company.
    await setDoc(doc(db, "companies", companyId, "contacts", id), newContact);
    return newContact;
}

/**
 * Updates an existing contact.
 * Automatically updates the updatedAt timestamp.
 * If isPrimary is being set to true, other primary contacts will be unset.
 * 
 * @param companyId - The ID of the parent company
 * @param contactId - The ID of the contact to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await updateContact("datadog-123", "john-doe-456", {
 *   role: "Senior Sales Engineer",
 *   phone: "+1-555-0124"
 * });
 */
export async function updateContact(
    companyId: string,
    contactId: string,
    updates: Partial<Omit<Contact, "id" | "companyId" | "createdAt">>
): Promise<void> {
    // If setting as primary, unset other primary contacts first
    if (updates.isPrimary === true) {
        await unsetAllPrimaryContacts(companyId, contactId);
    }

    const docRef = doc(db, "companies", companyId, "contacts", contactId);
    // Remove undefined values before updating Firestore (Firestore doesn't accept undefined)
    const cleanedUpdates = removeUndefinedFields({
        ...updates,
        updatedAt: Date.now(),
    });
    await updateDoc(docRef, cleanedUpdates);
}

/**
 * Deletes a contact from Firestore.
 * 
 * @param companyId - The ID of the parent company
 * @param contactId - The ID of the contact to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await deleteContact("datadog-123", "john-doe-456");
 */
export async function deleteContact(
    companyId: string,
    contactId: string
): Promise<void> {
    await deleteDoc(doc(db, "companies", companyId, "contacts", contactId));
}

/**
 * Sets a contact as the primary contact for a company.
 * Automatically unsets all other primary contacts.
 * This is a convenience method for the common operation of changing primary contact.
 * 
 * @param companyId - The ID of the parent company
 * @param contactId - The ID of the contact to set as primary
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await setPrimaryContact("datadog-123", "jane-smith-789");
 */
export async function setPrimaryContact(
    companyId: string,
    contactId: string
): Promise<void> {
    await updateContact(companyId, contactId, { isPrimary: true });
}

/**
 * Internal helper function to unset all primary contacts for a company.
 * Used when setting a new primary contact.
 * 
 * @param companyId - The ID of the company
 * @param excludeContactId - Optional contact ID to exclude from unsetting (the new primary)
 * @returns Promise that resolves when all updates are complete
 * @throws Error if Firestore operation fails
 * 
 * @internal
 */
async function unsetAllPrimaryContacts(
    companyId: string,
    excludeContactId?: string
): Promise<void> {
    const contacts = await getContactsByCompanyId(companyId);

    const updatePromises = contacts
        .filter(contact => contact.isPrimary && contact.id !== excludeContactId)
        .map(contact =>
            updateDoc(doc(db, "companies", companyId, "contacts", contact.id), {
                isPrimary: false,
                updatedAt: Date.now(),
            })
        );

    await Promise.all(updatePromises);
}

/**
 * Gets the primary contact for a company.
 * Returns null if no primary contact is set.
 * 
 * @param companyId - The ID of the company
 * @returns Promise resolving to the primary Contact object or null
 * @throws Error if Firestore query fails
 * 
 * @example
 * const primary = await getPrimaryContact("datadog-123");
 * if (primary) {
 *   console.log(`Contact ${primary.name} at ${primary.email}`);
 * }
 */
export async function getPrimaryContact(companyId: string): Promise<Contact | null> {
    const contacts = await getContactsByCompanyId(companyId);
    return contacts.find(contact => contact.isPrimary) || null;
}
