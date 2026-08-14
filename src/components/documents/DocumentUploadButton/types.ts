/**
 * @file DocumentUploadButton/types.ts
 * @description Shared types and constants for DocumentUploadButton
 */

import type { TransformationEntityType } from '@/lib/types';

// ============================================================================
// CONSTANTS
// ============================================================================

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.txt', '.md'];
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // PPTX
  'text/plain',
  'text/markdown',
];
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_FILES = 5; // Maximum files per upload batch

// ============================================================================
// TYPES
// ============================================================================

export interface EntitySelection {
  companies: string[];
  technologies: string[];
  useCases: string[];
}

export interface FileUploadItem {
  id: string;
  file: File;
  title: string;
  description: string;
  tags: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  progress: number;
  error?: string;
  aiGenerating?: boolean;
  uploadedDocumentId?: string;
  entitySelection: EntitySelection;
}

export interface UploadedDocument {
  id: string;
  title: string;
  type: string;
  status: string;
}

export interface DocumentUploadButtonProps {
  /** Custom button variant */
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  /** Custom button size */
  size?: 'default' | 'sm' | 'lg' | 'icon';
  /** Custom button label */
  label?: string;
  /** Show icon */
  showIcon?: boolean;
  /** Custom class name */
  className?: string;
  /** Callback when upload completes */
  onUploadComplete?: (document: UploadedDocument) => void;
}

/** Entity type mapping for entity-document links */
export const ENTITY_TYPE_MAP: Record<keyof EntitySelection, TransformationEntityType> = {
  companies: 'company',
  technologies: 'technology',
  useCases: 'useCase',
};
