'use client'

/**
 * @file DocumentsTab.tsx
 * @deprecated This component is deprecated. Use KnowledgeTab instead which combines
 * document linking with claims/evidence in a unified interface.
 *
 * Migration: Replace DocumentsTab with KnowledgeTab in entity sheets.
 * KnowledgeTab uses EntityDocumentLinks for normalized document relationships.
 *
 * @see KnowledgeTab
 * @see LinkedDocumentCard
 */

import * as React from 'react'

import {
  FileText,
  Link2,
  Trash2,
  ExternalLink,
  Loader2,
  Plus,
  File,
  FileImage,
  FileSpreadsheet,
  Presentation,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('ui/DocumentsTab')

let _deprecatedWarned = false

// ============================================================================
// TYPES
// ============================================================================

export interface Document {
  id: string
  name: string
  url: string
  type: 'link' | 'file'
  mimeType?: string
  size?: number
  createdAt: number
  updatedAt: number
}

interface DocumentsTabProps {
  /** Array of documents */
  documents: Document[]
  /** Whether data is loading */
  isLoading?: boolean
  /** Callback to add a document */
  onAddDocument: (doc: Omit<Document, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  /** Callback to delete a document */
  onDeleteDocument?: (id: string) => Promise<void>
  /** Whether in read-only mode */
  readOnly?: boolean
  /** Additional class names */
  className?: string
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getFileIcon(mimeType?: string) {
  if (!mimeType) return File
  if (mimeType.startsWith('image/')) return FileImage
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return FileSpreadsheet
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return Presentation
  if (mimeType.includes('pdf')) return FileText
  return File
}

function formatFileSize(bytes?: number) {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * DocumentsTab
 *
 * Tab component for managing entity documents and links.
 * Supports adding external links and viewing document metadata.
 */
export function DocumentsTab({
  documents,
  isLoading = false,
  onAddDocument,
  onDeleteDocument,
  readOnly = false,
  className,
}: DocumentsTabProps) {
  if (!_deprecatedWarned) {
    _deprecatedWarned = true
    log.warn('DocumentsTab is deprecated. Use KnowledgeTab instead for document management.')
  }

  const [isAddDialogOpen, setIsAddDialogOpen] = React.useState(false)
  const [isAdding, setIsAdding] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [newLink, setNewLink] = React.useState({ name: '', url: '' })

  const handleAddLink = async () => {
    if (!newLink.name.trim() || !newLink.url.trim()) return

    setIsAdding(true)
    try {
      await onAddDocument({
        name: newLink.name.trim(),
        url: newLink.url.trim(),
        type: 'link',
      })
      setNewLink({ name: '', url: '' })
      setIsAddDialogOpen(false)
    } finally {
      setIsAdding(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!onDeleteDocument) return

    setDeletingId(id)
    try {
      await onDeleteDocument(id)
    } finally {
      setDeletingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <div className="h-10 w-32 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Add Button */}
      {!readOnly && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setIsAddDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Link
          </Button>
        </div>
      )}

      {/* Documents List */}
      <ScrollArea className="flex-1">
        <div className="space-y-2">
          {documents.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <FileText className="mx-auto mb-2 h-8 w-8 opacity-50" />
              No documents yet.
              {!readOnly && ' Add a link to get started.'}
            </div>
          ) : (
            documents.map((doc) => (
              <DocumentCard
                key={doc.id}
                document={doc}
                onDelete={onDeleteDocument ? () => handleDelete(doc.id) : undefined}
                isDeleting={deletingId === doc.id}
                readOnly={readOnly}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Add Link Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Add External Link
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="link-name">Name</Label>
              <Input
                id="link-name"
                value={newLink.name}
                onChange={(e) => setNewLink({ ...newLink, name: e.target.value })}
                placeholder="Document name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="link-url">URL</Label>
              <Input
                id="link-url"
                type="url"
                value={newLink.url}
                onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
                placeholder="https://..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddLink}
              disabled={!newLink.name.trim() || !newLink.url.trim() || isAdding}
            >
              {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============================================================================
// DOCUMENT CARD
// ============================================================================

interface DocumentCardProps {
  document: Document
  onDelete?: () => void
  isDeleting?: boolean
  readOnly?: boolean
}

function DocumentCard({ document, onDelete, isDeleting, readOnly }: DocumentCardProps) {
  const FileIcon = document.type === 'link' ? Link2 : getFileIcon(document.mimeType)

  return (
    <div className="group flex items-center gap-3 rounded-lg border bg-card p-3 hover:bg-muted/50 transition-colors">
      {/* Icon */}
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
        <FileIcon className="h-5 w-5 text-muted-foreground" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{document.name}</span>
          <Badge variant="outline" className="text-xs">
            {document.type}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{document.url}</span>
          {document.size && (
            <>
              <span>·</span>
              <span>{formatFileSize(document.size)}</span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          asChild
        >
          <a href={document.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
        {!readOnly && onDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={onDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { DocumentsTabProps }
