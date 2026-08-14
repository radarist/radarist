import {
  INTERNAL_MCP_SERVERS,
  DOMAIN_MCP_SERVERS,
  AUXILIARY_INTERNAL_MCP_SERVERS,
  isInternalMcpServer,
  stripImpulsePrefix,
} from '../internal-servers';

describe('internal MCP server catalog (OPS-004 canonical surface)', () => {
  it('lists exactly the 11 platform-served servers /api/mcp/[server] mounts', () => {
    expect(INTERNAL_MCP_SERVERS).toEqual([
      'entities',
      'graph',
      'signals',
      'research',
      'radar',
      'reports',
      'gemini-image',
      'gemini-embeddings',
      'gemini-research',
      'gemini-grounding',
      'super-graph',
    ]);
    expect(INTERNAL_MCP_SERVERS).toHaveLength(11);
    expect([...DOMAIN_MCP_SERVERS, ...AUXILIARY_INTERNAL_MCP_SERVERS]).toEqual([...INTERNAL_MCP_SERVERS]);
  });

  it('recognizes bare and impulse-prefixed platform names, and rejects third-party names', () => {
    expect(isInternalMcpServer('reports')).toBe(true);
    expect(isInternalMcpServer('impulse-reports')).toBe(true);
    expect(isInternalMcpServer('gemini-image')).toBe(true);
    expect(isInternalMcpServer('super-graph')).toBe(true);
    // Third-party stdio servers are never platform-served.
    for (const external of [
      'exa',
      'arxiv',
      'firecrawl',
      'playwright',
      'github',
      'antv-chart',
      'filesystem',
      'neo4j-memory',
    ]) {
      expect(isInternalMcpServer(external)).toBe(false);
    }
  });

  it('strips the impulse- prefix used by the agent runtime', () => {
    expect(stripImpulsePrefix('impulse-graph')).toBe('graph');
    expect(stripImpulsePrefix('exa')).toBe('exa');
  });
});
