/**
 * @file ContactManager.tsx
 * @description Component for managing multiple contacts within a company.
 *
 * This component provides a list of contacts with the ability to add, edit, and delete contacts.
 * Contacts are stored as a subcollection in Firestore under each company document.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/feedback/EmptyState';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Edit, Trash2, Mail, Phone, Linkedin, Star, StarOff, Users } from 'lucide-react';
import type { Contact } from '@/lib/types';
import { getContactsByCompanyId, createContact, updateContact, deleteContact, setPrimaryContact } from '@/lib/contacts';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/ContactManager');

interface ContactManagerProps {
  /** Company ID */
  companyId: string;
  /** Reports the current contact count upward (e.g. for a drawer tab badge) */
  onCountChange?: (count: number) => void;
}

/**
 * ContactManager component.
 * Displays and manages all contacts for a company.
 *
 * @param props - Component props
 * @returns The rendered contact manager
 */
export function ContactManager({ companyId, onCountChange }: ContactManagerProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [formData, setFormData] = useState<Partial<Contact>>({
    name: '',
    role: '',
    email: '',
    phone: '',
    linkedin: '',
    notes: '',
    isPrimary: false,
  });
  const { toast } = useToast();

  /**
   * Loads contacts from Firestore.
   */
  const loadContacts = async () => {
    setIsLoading(true);
    try {
      const data = await getContactsByCompanyId(companyId);
      setContacts(data);
    } catch (error) {
      log.error('Failed to load contacts', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to load contacts.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadContacts();
  }, [companyId]);

  // Report the live count upward so the parent drawer can badge its tab —
  // fires on initial load and after every add/delete (loadContacts() re-runs).
  useEffect(() => {
    onCountChange?.(contacts.length);
  }, [contacts.length, onCountChange]);

  /**
   * Opens the dialog for adding a new contact.
   */
  const handleAddContact = () => {
    setEditingContact(null);
    setFormData({
      name: '',
      role: '',
      email: '',
      phone: '',
      linkedin: '',
      notes: '',
      isPrimary: contacts.length === 0, // First contact is primary by default
    });
    setIsDialogOpen(true);
  };

  /**
   * Opens the dialog for editing an existing contact.
   */
  const handleEditContact = (contact: Contact) => {
    setEditingContact(contact);
    setFormData(contact);
    setIsDialogOpen(true);
  };

  /**
   * Handles form submission (create or update).
   */
  const handleSubmit = async () => {
    if (!formData.name || !formData.email) {
      toast({
        title: 'Validation Error',
        description: 'Name and email are required.',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (editingContact) {
        await updateContact(companyId, editingContact.id, formData);
        toast({ title: 'Contact Updated', description: 'Contact has been updated successfully.' });
      } else {
        await createContact(companyId, formData as any);
        toast({ title: 'Contact Created', description: 'Contact has been added successfully.' });
      }
      setIsDialogOpen(false);
      loadContacts();
    } catch (error) {
      log.error('Failed to save contact', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to save contact.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Handles contact deletion.
   */
  const handleDelete = async (contactId: string) => {
    if (!confirm('Are you sure you want to delete this contact?')) return;

    try {
      await deleteContact(companyId, contactId);
      toast({ title: 'Contact Deleted', description: 'Contact has been removed successfully.' });
      loadContacts();
    } catch (error) {
      log.error('Failed to delete contact', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to delete contact.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Toggles a contact as primary.
   */
  const handleTogglePrimary = async (contactId: string) => {
    try {
      await setPrimaryContact(companyId, contactId);
      toast({ title: 'Primary Contact Updated', description: 'Primary contact has been changed.' });
      loadContacts();
    } catch (error) {
      log.error('Failed to set primary contact', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to set primary contact.',
        variant: 'destructive',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}
        </p>
        <Button onClick={handleAddContact} variant="outline" size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Contact
        </Button>
      </div>

      {contacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No contacts yet"
          action={{ label: 'Add First Contact', onClick: handleAddContact, icon: Plus, variant: 'outline' }}
        />
      ) : (
        <div className="space-y-3">
          {contacts.map((contact) => (
            <Card key={contact.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h4 className="font-semibold">{contact.name}</h4>
                    {contact.isPrimary && (
                      <Badge variant="default" className="gap-1">
                        <Star className="h-3 w-3" />
                        Primary
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">{contact.role}</p>

                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <a href={`mailto:${contact.email}`} className="text-primary hover:underline">
                        {contact.email}
                      </a>
                    </div>

                    {contact.phone && (
                      <div className="flex items-center gap-2">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        <a href={`tel:${contact.phone}`} className="text-primary hover:underline">
                          {contact.phone}
                        </a>
                      </div>
                    )}

                    {contact.linkedin && (
                      <div className="flex items-center gap-2">
                        <Linkedin className="h-4 w-4 text-muted-foreground" />
                        <a
                          href={contact.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          LinkedIn Profile
                        </a>
                      </div>
                    )}

                    {contact.notes && <p className="text-muted-foreground italic mt-2 text-xs">{contact.notes}</p>}
                  </div>
                </div>

                <div className="flex gap-1 ml-4">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleTogglePrimary(contact.id)}
                    title={contact.isPrimary ? 'Remove as primary' : 'Set as primary'}
                  >
                    {contact.isPrimary ? <Star className="h-4 w-4 fill-current" /> : <StarOff className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleEditContact(contact)}
                    aria-label={`Edit contact ${contact.name}`}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(contact.id)}
                    aria-label={`Delete contact ${contact.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Contact Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingContact ? 'Edit Contact' : 'Add New Contact'}</DialogTitle>
            <DialogDescription>
              {editingContact ? 'Update contact information' : 'Add a new contact person for this company'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="contact-name">Name *</Label>
              <Input
                id="contact-name"
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="John Doe"
              />
            </div>

            <div>
              <Label htmlFor="contact-role">Role</Label>
              <Input
                id="contact-role"
                value={formData.role || ''}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                placeholder="Sales Engineer"
              />
            </div>

            <div>
              <Label htmlFor="contact-email">Email *</Label>
              <Input
                id="contact-email"
                type="email"
                value={formData.email || ''}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="john.doe@example.com"
              />
            </div>

            <div>
              <Label htmlFor="contact-phone">Phone</Label>
              <Input
                id="contact-phone"
                type="tel"
                value={formData.phone || ''}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="+1-555-0123"
              />
            </div>

            <div>
              <Label htmlFor="contact-linkedin">LinkedIn</Label>
              <Input
                id="contact-linkedin"
                type="url"
                value={formData.linkedin || ''}
                onChange={(e) => setFormData({ ...formData, linkedin: e.target.value })}
                placeholder="https://linkedin.com/in/johndoe"
              />
            </div>

            <div>
              <Label htmlFor="contact-notes">Notes</Label>
              <Textarea
                id="contact-notes"
                value={formData.notes || ''}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Additional notes..."
                rows={3}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="contact-primary"
                checked={formData.isPrimary || false}
                onChange={(e) => setFormData({ ...formData, isPrimary: e.target.checked })}
                className="h-4 w-4 rounded border-border"
              />
              <Label htmlFor="contact-primary" className="cursor-pointer">
                Set as primary contact
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>{editingContact ? 'Update' : 'Add'} Contact</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
