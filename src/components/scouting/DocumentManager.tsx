/**
 * @file DocumentManager.tsx
 * @description Component for managing company documents (files and external links).
 *
 * This component allows uploading files and adding external links (e.g., Google Docs, presentations).
 * Documents are categorized for easy organization.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/feedback/EmptyState';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, FileText, Link as LinkIcon, Trash2, ExternalLink } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { Company } from '@/lib/types';

interface DocumentManagerProps {
  /** Company data */
  company: Company;
  /** Callback when documents are updated */
  onUpdate: (documents: Company['documents']) => Promise<boolean | void> | boolean | void;
}

/**
 * DocumentManager component.
 * Manages files and external links for a company.
 *
 * Note: File upload to Firebase Storage is not yet implemented.
 * This is a placeholder UI that stores document metadata only.
 *
 * @param props - Component props
 * @returns The rendered document manager
 */
export function DocumentManager({ company, onUpdate }: DocumentManagerProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [docName, setDocName] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  /**
   * Adds a new external link document.
   */
  const handleAddLink = async () => {
    if (!docName.trim() || !docUrl.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Name and URL are required.',
        variant: 'destructive',
      });
      return;
    }

    const newDoc = {
      id: `doc-${Date.now()}`,
      name: docName.trim(),
      type: 'link' as const,
      url: docUrl.trim(),
      uploadedAt: Date.now(),
    };

    setIsSaving(true);
    try {
      const saved = await onUpdate([...company.documents, newDoc]);
      if (saved === false) return;
      setIsDialogOpen(false);
      setDocName('');
      setDocUrl('');
      toast({
        title: 'Document Added',
        description: 'External link has been added successfully.',
      });
    } catch {
      toast({
        title: 'Document not added',
        description: 'The document link could not be saved. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Removes a document.
   */
  const handleRemove = async (index: number) => {
    if (!confirm('Are you sure you want to remove this document?')) return;

    const updated = company.documents.filter((_, i) => i !== index);
    setIsSaving(true);
    try {
      const saved = await onUpdate(updated);
      if (saved === false) return;
      toast({
        title: 'Document Removed',
        description: 'Document has been removed successfully.',
      });
    } catch {
      toast({
        title: 'Document not removed',
        description: 'The document link could not be removed. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {company.documents.length} {company.documents.length === 1 ? 'document' : 'documents'}
        </p>
        <Button onClick={() => setIsDialogOpen(true)} variant="outline" size="sm" className="gap-2" disabled={isSaving}>
          <Plus className="h-4 w-4" />
          Add Link
        </Button>
      </div>

      {company.documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          action={{ label: 'Add Document Link', onClick: () => setIsDialogOpen(true), icon: Plus, variant: 'outline' }}
        />
      ) : (
        <div className="space-y-3">
          {company.documents.map((doc, index) => (
            <Card key={index} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1">
                  <LinkIcon className="h-5 w-5 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium truncate">{doc.name}</h4>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline flex items-center gap-1 truncate"
                    >
                      {doc.url}
                      <ExternalLink className="h-3 w-3 flex-shrink-0" />
                    </a>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemove(index)}
                  disabled={isSaving}
                  aria-label={`Remove document ${doc.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add Link Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add External Document Link</DialogTitle>
            <DialogDescription>Add a link to an external document (Google Docs, Dropbox, etc.)</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="doc-name">Document Name *</Label>
              <Input
                id="doc-name"
                value={docName}
                onChange={(e) => setDocName(e.target.value)}
                placeholder="e.g., Product Presentation"
              />
            </div>

            <div>
              <Label htmlFor="doc-url">Document URL *</Label>
              <Input
                id="doc-url"
                type="url"
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddLink} disabled={isSaving}>
              Add Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="pt-4 border-t">
        <p className="text-xs text-muted-foreground italic">
          Note: File upload functionality will be added in a future update. For now, you can add links to external
          documents.
        </p>
      </div>
    </div>
  );
}
