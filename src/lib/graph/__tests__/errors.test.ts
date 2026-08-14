/**
 * Unit tests for graph domain errors.
 *
 * @jest-environment node
 */

import { GraphUnavailableError } from '../errors';

describe('GraphUnavailableError', () => {
  it('extends Error and sets the name', () => {
    const error = new GraphUnavailableError('query');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error.name).toBe('GraphUnavailableError');
  });

  it('carries backend and operation context', () => {
    const error = new GraphUnavailableError('createNode', 'firestore-fallback');

    expect(error.operation).toBe('createNode');
    expect(error.backend).toBe('firestore-fallback');
    expect(error.message).toContain('createNode');
    expect(error.message).toContain('firestore-fallback');
  });

  it('defaults the backend to firestore-fallback', () => {
    const error = new GraphUnavailableError('bulkCreateRelations');

    expect(error.backend).toBe('firestore-fallback');
  });

  it('accepts a custom message', () => {
    const error = new GraphUnavailableError('query', 'firestore-fallback', 'custom message');

    expect(error.message).toBe('custom message');
    expect(error.operation).toBe('query');
  });
});
