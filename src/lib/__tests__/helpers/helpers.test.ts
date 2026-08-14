/**
 * Tests for shared test helpers
 */
import { createInngestMock } from './inngest-mock';
import { createFirebaseAuthMock } from './firebase-auth-mock';
import { createNeo4jMock } from './neo4j-mock';
import { createGeminiMock } from './gemini-mock';

describe('test helpers', () => {
  describe('createInngestMock', () => {
    it('should register and retrieve handlers', () => {
      const { inngestMock, getRegisteredHandler } = createInngestMock();
      const handler = jest.fn();
      inngestMock.inngest.createFunction({ id: 'test-fn' }, { event: 'test' }, handler);
      expect(getRegisteredHandler('test-fn')).toBe(handler);
    });

    it('should mock send', async () => {
      const { inngestMock } = createInngestMock();
      const result = await inngestMock.inngest.send({ name: 'test', data: {} });
      expect(result).toEqual({ ids: ['mock-event-id'] });
    });
  });

  describe('createFirebaseAuthMock', () => {
    it('should verify token with default user', async () => {
      const { firebaseAdminMock } = createFirebaseAuthMock();
      const result = await firebaseAdminMock.adminAuth.verifyIdToken('token');
      expect(result.uid).toBe('test-user-id');
    });

    it('should allow custom user', async () => {
      const { firebaseAdminMock } = createFirebaseAuthMock({ uid: 'custom', email: 'custom@test.com' });
      const result = await firebaseAdminMock.adminAuth.verifyIdToken('token');
      expect(result.uid).toBe('custom');
    });

    it('should allow setting user after creation', async () => {
      const { firebaseAdminMock, setUser } = createFirebaseAuthMock();
      setUser({ uid: 'new-user', email: 'new@test.com' });
      const result = await firebaseAdminMock.adminAuth.verifyIdToken('token');
      expect(result.uid).toBe('new-user');
    });
  });

  describe('createNeo4jMock', () => {
    it('should create a mock session', () => {
      const { mockSession } = createNeo4jMock();
      expect(mockSession.run).toBeDefined();
      expect(mockSession.close).toBeDefined();
    });

    it('should allow mocking query results', async () => {
      const { mockSession, mockQueryResult } = createNeo4jMock();
      mockQueryResult([{ name: 'Test', id: '1' }]);
      const result = await mockSession.run('MATCH (n) RETURN n');
      expect(result.records[0].get('name')).toBe('Test');
    });
  });

  describe('createGeminiMock', () => {
    it('should mock generateContent', async () => {
      const { geminiMock } = createGeminiMock();
      const result = await geminiMock.generateContent('test');
      expect(result).toBe('Mock AI response');
    });

    it('should allow custom responses', async () => {
      const { geminiMock, mockResponse } = createGeminiMock();
      mockResponse('Custom response');
      const result = await geminiMock.generateContent('test');
      expect(result).toBe('Custom response');
    });

    it('should mock structured responses', async () => {
      const { geminiMock, mockStructuredResponse } = createGeminiMock();
      mockStructuredResponse({ score: 0.9, label: 'positive' });
      const result = await geminiMock.generateStructuredContent('test', {});
      expect(result).toEqual({ score: 0.9, label: 'positive' });
    });
  });
});
