/**
 * @file lib/mission-salvage.ts
 * @description Tier 3 Task 6 — workspace file salvage on timeout.
 *
 * Agents write intermediate + final artifacts to their workspace directory
 * (`<project>/workspace/{agent}/...`) during a mission. If the mission
 * times out before persisting those artifacts to Firestore (e.g. creator
 * agent times out mid-`publishReport`, or earlier in `draftReport`), the files exist on disk
 * but never reach the user.
 *
 * This module scans the workspace for relevant files and attaches them
 * to the mission doc so the UI can surface partial work even when the
 * agent didn't finish.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Attachments are filtered through a whitelist to avoid salvaging junk. */
const WHITELIST_EXTENSIONS = new Set(['.html', '.md', '.markdown', '.json', '.txt', '.csv', '.svg']);

/** Content is inlined only if the file is text-like AND under this size. */
const INLINE_CONTENT_MAX_BYTES = 50 * 1024; // 50 KB

/** Hard cap on total attachments per mission — prevents Firestore-doc bloat. */
const MAX_ATTACHMENTS_PER_MISSION = 20;

/** Hard cap on each file's sizeBytes to record (bytes above this trigger metadata-only). */
const PER_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export interface SalvagedAttachment {
  filename: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  content?: string;
  savedAt: string;
  salvaged: boolean;
}

/** Naïve extension → MIME mapping sufficient for the whitelist above. */
function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.svg': 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Recursively walk a directory and return all file paths (depth-first).
 * Silently returns [] on any IO error so callers never need to catch.
 */
function walkFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Scan `<workspaceRoot>/<agent>/mission-<id>/` for whitelisted files and
 * return an array of attachment records. For small text files the content
 * is inlined; for larger/binary files only metadata is recorded.
 *
 * Best-effort: returns [] if the workspace dir doesn't exist or can't be
 * read. Never throws.
 */
export function salvageWorkspace(workspaceRoot: string, agent: string, missionId: string): SalvagedAttachment[] {
  const missionDir = path.join(workspaceRoot, agent, `mission-${missionId}`);
  if (!fs.existsSync(missionDir)) return [];

  const now = new Date().toISOString();
  const files = walkFiles(missionDir);
  const attachments: SalvagedAttachment[] = [];

  for (const filePath of files) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MISSION) break;

    const ext = path.extname(filePath).toLowerCase();
    if (!WHITELIST_EXTENSIONS.has(ext)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > PER_FILE_MAX_BYTES) continue;

    const attachment: SalvagedAttachment = {
      filename: path.basename(filePath),
      relativePath: path.relative(missionDir, filePath),
      mimeType: mimeFor(ext),
      sizeBytes: stat.size,
      savedAt: now,
      salvaged: true,
    };

    // Inline content only for small text-like files.
    const isTextLike = !ext.endsWith('.svg') && mimeFor(ext).startsWith('text/');
    if (isTextLike && stat.size <= INLINE_CONTENT_MAX_BYTES) {
      try {
        attachment.content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        // content remains undefined — metadata only
      }
    }

    attachments.push(attachment);
  }

  return attachments;
}
