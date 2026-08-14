import { buildMermaidSource } from '../branches/mermaid';
import { lightEditorial } from '../design-tokens';

describe('buildMermaidSource', () => {
  const tokens = lightEditorial();

  it('builds a flowchart source', () => {
    const src = buildMermaidSource(
      'flowchart',
      {
        direction: 'TD',
        nodes: [
          { id: 'A', label: 'Start', shape: 'round' },
          { id: 'B', label: 'End', shape: 'rect' },
        ],
        edges: [{ from: 'A', to: 'B', label: 'next' }],
      },
      tokens
    );
    expect(src).toContain('flowchart TD');
    expect(src).toContain('A((Start))');
    expect(src).toContain('B[End]');
    expect(src).toMatch(/A -- ?next ?--> B/);
  });

  it('builds a sequence source', () => {
    const src = buildMermaidSource(
      'sequence',
      {
        actors: ['Alice', 'Bob'],
        messages: [{ from: 'Alice', to: 'Bob', text: 'Hello', arrow: '->>' }],
      },
      tokens
    );
    expect(src).toContain('sequenceDiagram');
    expect(src).toContain('participant Alice');
    expect(src).toContain('Alice->>Bob: Hello');
  });

  it('builds a gantt source', () => {
    const src = buildMermaidSource(
      'gantt',
      {
        title: 'Roadmap',
        sections: [
          {
            name: 'Q1',
            tasks: [{ name: 'Build foundation', id: 't1', start: '2026-01-01', end: '2026-02-01' }],
          },
        ],
      },
      tokens
    );
    expect(src).toContain('gantt');
    expect(src).toContain('section Q1');
    expect(src).toContain('Build foundation :t1, 2026-01-01,');
  });

  it('builds a mindmap source', () => {
    const src = buildMermaidSource(
      'mindmap',
      {
        root: { label: 'Idea', children: [{ label: 'A' }, { label: 'B', children: [{ label: 'B1' }] }] },
      },
      tokens
    );
    expect(src).toContain('mindmap');
    expect(src).toContain('Idea');
    expect(src).toContain('  A');
    expect(src).toContain('    B1');
  });

  it('injects themeCSS that maps section colors to tokens', () => {
    const src = buildMermaidSource('mindmap', { root: { label: 'Root', children: [{ label: 'A' }] } }, tokens);
    // First sequence color should appear in themeCSS as section-0 fill.
    expect(src).toContain('.section-0');
    expect(src).toContain(tokens.color.sequence[0]);
  });
});
