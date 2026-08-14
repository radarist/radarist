/**
 * Tests for Claude system prompt builder (Task 2.4)
 */

import { buildClaudeSystemPrompt, formatConversationHistory } from '../claude-system-prompt';

describe('Claude System Prompt', () => {
  describe('buildClaudeSystemPrompt', () => {
    const baseContext = {
      currentRoute: '/dashboard',
      currentPage: 'Dashboard',
    };

    it('should include platform identity', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('Radarist');
      expect(prompt).toContain('innovation radar');
    });

    it('should include page context', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('Dashboard');
      expect(prompt).toContain('/dashboard');
    });

    it('should include entity context when present', () => {
      const prompt = buildClaudeSystemPrompt({
        ...baseContext,
        entity: { type: 'company', id: 'c1', name: 'Acme Corp' },
      });
      expect(prompt).toContain('company');
      expect(prompt).toContain('Acme Corp');
      expect(prompt).toContain('c1');
    });

    it('should include entity data when available', () => {
      const prompt = buildClaudeSystemPrompt({
        ...baseContext,
        entity: { type: 'company', id: 'c1', name: 'Acme', data: { industry: 'Tech' } },
      });
      expect(prompt).toContain('Tech');
    });

    it('should include recent entities', () => {
      const prompt = buildClaudeSystemPrompt({
        ...baseContext,
        recentEntities: [
          { type: 'company', id: 'c1', name: 'Acme' },
          { type: 'technology', id: 't1', name: 'React' },
        ],
      });
      expect(prompt).toContain('Acme');
      expect(prompt).toContain('React');
    });

    it('should include file content when provided', () => {
      const prompt = buildClaudeSystemPrompt(baseContext, {
        name: 'report.pdf',
        type: 'application/pdf',
        text: 'File content here',
        pageCount: 5,
      });
      expect(prompt).toContain('report.pdf');
      expect(prompt).toContain('5 pages');
      expect(prompt).toContain('File content here');
    });

    it('should include document references', () => {
      const prompt = buildClaudeSystemPrompt(baseContext, undefined, [
        { documentId: 'd1', name: 'AI Research Report' },
      ]);
      expect(prompt).toContain('AI Research Report');
      expect(prompt).toContain('d1');
    });

    it('should include tool groups', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('searchEntities');
      expect(prompt).toContain('publishReport');
      expect(prompt).toContain('draftReport');
      expect(prompt).toContain('Creator mission alone owns draftReport/publishReport');
      expect(prompt).toContain('interactive chat must use startMission');
    });

    it('should include behavioral guidelines', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('confirmation');
      expect(prompt).toContain('concise');
    });

    it('does not upgrade indirect graph proximity into a direct business claim', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('multi-hop graph path proves only');
      expect(prompt).toMatch(/does \*\*NOT\*\* prove a direct business action/i);
      expect(prompt).toContain('never merge separate stored observations');
    });

    it('requires the exact server phrase for destructive deletions', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('"CONFIRM DELETE ..."');
      expect(prompt).toContain('NEXT raw user message exactly matches');
      expect(prompt).toContain('generic yes');
      expect(prompt).toContain('STOP for the turn');
    });

    it('should include entity types reference', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('Technologies');
      expect(prompt).toContain('Companies');
      expect(prompt).toContain('Signals');
    });
  });

  describe('formatConversationHistory', () => {
    it('should return empty string for no history', () => {
      expect(formatConversationHistory()).toBe('');
      expect(formatConversationHistory([])).toBe('');
    });

    it('should format user messages', () => {
      const result = formatConversationHistory([{ role: 'user', content: 'Hello' }]);
      expect(result).toContain('User: Hello');
    });

    it('should format assistant messages', () => {
      const result = formatConversationHistory([{ role: 'assistant', content: 'Hi there' }]);
      expect(result).toContain('Assistant: Hi there');
    });

    it('should format multi-turn history', () => {
      const result = formatConversationHistory([
        { role: 'user', content: 'What is React?' },
        { role: 'assistant', content: 'React is a UI library.' },
        { role: 'user', content: 'Tell me more.' },
      ]);
      expect(result).toContain('User: What is React?');
      expect(result).toContain('Assistant: React is a UI library.');
      expect(result).toContain('User: Tell me more.');
    });

    it('should include continuation instruction', () => {
      const result = formatConversationHistory([{ role: 'user', content: 'test' }]);
      expect(result).toContain('Continue naturally');
    });
  });

  describe('skill-activation contract', () => {
    const baseContext = { currentRoute: '/dashboard', currentPage: 'Dashboard' };

    it('contains the SKILL-ACTIVATION CONTRACT line after CRITICAL DIMENSIONS', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toContain('CRITICAL DIMENSIONS');
      expect(prompt).toContain('SKILL-ACTIVATION CONTRACT');
      const dimsIdx = prompt.indexOf('CRITICAL DIMENSIONS');
      const contractIdx = prompt.indexOf('SKILL-ACTIVATION CONTRACT');
      expect(contractIdx).toBeGreaterThan(dimsIdx);
    });

    it('describes PRECOMPUTED DISCIPLINE blocks as non-negotiable verbatim content', () => {
      const prompt = buildClaudeSystemPrompt(baseContext);
      expect(prompt).toMatch(/PRECOMPUTED DISCIPLINE.{0,250}(non-negotiable|verbatim)/s);
    });
  });
});
