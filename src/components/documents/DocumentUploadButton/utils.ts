/**
 * @file DocumentUploadButton/utils.ts
 * @description Helper functions for DocumentUploadButton
 */

import { FileText, Presentation } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/DocumentUploadButton');

/**
 * Generate a simple random ID for file tracking
 */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

/**
 * Get the appropriate icon component for a file based on extension
 */
export function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'pptx') return Presentation;
  return FileText;
}

/**
 * Generate AI suggestions for document metadata based on filename.
 * Falls back to cleaned-up filename when the AI endpoint fails.
 */
export async function generateAIMetadata(
  fileName: string
): Promise<{ title: string; description: string; tags: string }> {
  try {
    const response = await fetchWithAuth('/api/ai/document-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName }) });

    if (!response.ok) {
      throw new Error('AI metadata generation failed');
    }

    return await response.json();
  } catch (error) {
    log.warn('AI metadata generation failed, using fallback', {
      error: error instanceof Error ? error.message : String(error) });
    // Fallback: generate basic metadata from filename
    const cleanName = fileName.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    const words = cleanName.split(' ');
    const capitalizedName = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    return {
      title: capitalizedName,
      description: '',
      tags: '' };
  }
}
