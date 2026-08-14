import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { salvageWorkspace } from '../mission-salvage';

function setupWorkspace(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'salvage-test-'));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('salvageWorkspace', () => {
  it('returns [] when the mission directory does not exist', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      const atts = salvageWorkspace(root, 'creator', 'mission-does-not-exist');
      expect(atts).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('returns [] when the workspace root does not exist', () => {
    const atts = salvageWorkspace('/definitely/does/not/exist', 'creator', 'm1');
    expect(atts).toEqual([]);
  });

  it('salvages whitelisted files and skips non-whitelisted extensions', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      writeFile(root, 'creator/mission-m1/report.html', '<html>hello</html>');
      writeFile(root, 'creator/mission-m1/notes.md', '# notes');
      writeFile(root, 'creator/mission-m1/data.json', '{"ok":true}');
      writeFile(root, 'creator/mission-m1/scratch.tmp', 'ignore me');
      writeFile(root, 'creator/mission-m1/binary.exe', 'fake binary');

      const atts = salvageWorkspace(root, 'creator', 'm1');
      const filenames = atts.map((a) => a.filename).sort();
      expect(filenames).toEqual(['data.json', 'notes.md', 'report.html']);
    } finally {
      cleanup();
    }
  });

  it('inlines content only for text-like files under 50KB', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      const smallText = '# small markdown\n' + 'x'.repeat(1000);
      const bigText = 'y'.repeat(60 * 1024); // 60KB — over the inline cap
      writeFile(root, 'creator/mission-m2/small.md', smallText);
      writeFile(root, 'creator/mission-m2/big.md', bigText);

      const atts = salvageWorkspace(root, 'creator', 'm2');
      const small = atts.find((a) => a.filename === 'small.md')!;
      const big = atts.find((a) => a.filename === 'big.md')!;

      expect(small.content).toBe(smallText);
      expect(big.content).toBeUndefined();
      expect(big.sizeBytes).toBe(60 * 1024);
    } finally {
      cleanup();
    }
  });

  it('marks all salvaged attachments with salvaged=true', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      writeFile(root, 'creator/mission-m3/report.html', '<html></html>');
      const atts = salvageWorkspace(root, 'creator', 'm3');
      expect(atts).toHaveLength(1);
      expect(atts[0].salvaged).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('recurses into nested subdirectories', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      writeFile(root, 'creator/mission-m4/reports/final.html', '<html/>');
      writeFile(root, 'creator/mission-m4/charts/bar.svg', '<svg/>');

      const atts = salvageWorkspace(root, 'creator', 'm4');
      const paths = atts.map((a) => a.relativePath).sort();
      expect(paths).toContain(path.join('reports', 'final.html'));
      expect(paths).toContain(path.join('charts', 'bar.svg'));
    } finally {
      cleanup();
    }
  });

  it('assigns appropriate MIME types', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      writeFile(root, 'creator/mission-m5/a.html', '<html/>');
      writeFile(root, 'creator/mission-m5/b.md', '# md');
      writeFile(root, 'creator/mission-m5/c.json', '{}');
      writeFile(root, 'creator/mission-m5/d.svg', '<svg/>');

      const atts = salvageWorkspace(root, 'creator', 'm5');
      const byName = Object.fromEntries(atts.map((a) => [a.filename, a.mimeType]));
      expect(byName['a.html']).toBe('text/html');
      expect(byName['b.md']).toBe('text/markdown');
      expect(byName['c.json']).toBe('application/json');
      expect(byName['d.svg']).toBe('image/svg+xml');
    } finally {
      cleanup();
    }
  });

  it('caps total attachments at MAX_ATTACHMENTS_PER_MISSION', () => {
    const { root, cleanup } = setupWorkspace();
    try {
      for (let i = 0; i < 25; i++) {
        writeFile(root, `creator/mission-m6/f${i}.md`, `# file ${i}`);
      }
      const atts = salvageWorkspace(root, 'creator', 'm6');
      expect(atts.length).toBeLessThanOrEqual(20);
    } finally {
      cleanup();
    }
  });
});
