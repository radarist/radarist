/**
 * @file constants.ts
 * @description AI constants and re-exports that can't be in 'use server' files
 *
 * Server Actions files (with 'use server') can only export async functions.
 * This file provides constants and type re-exports for use across the codebase.
 *
 * @author Radarist Team
 * @created 2026-01-14
 */

import { TaskType } from '@google/generative-ai';
import { geminiEmbeddingModel, geminiEmbeddingDim } from './model-config';

// Re-export TaskType for consumers
export { TaskType };

/**
 * Default embedding model — env-backed via geminiEmbeddingModel()
 * (default: gemini-embedding-001, with Matryoshka truncation to EMBEDDING_DIMENSION).
 * gemini-embedding-001 returns 3072 dims by default; we truncate for Neo4j vector
 * index compatibility. Override with GEMINI_EMBEDDING_MODEL.
 */
export const DEFAULT_EMBEDDING_MODEL = geminiEmbeddingModel();

/**
 * Embedding dimension for the Neo4j vector index.
 * Env-backed via geminiEmbeddingDim() (default: 768). Override with GEMINI_EMBEDDING_DIM.
 */
export const EMBEDDING_DIMENSION = geminiEmbeddingDim();
