import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  validatePublicDocumentation,
  validateReleaseIdentity,
  type ReadSource,
} from '../check-version-consistency';

const VERSION = '0.1.0-prototype-rc.2';

function makeSources(overrides: Record<string, string> = {}): ReadSource {
  const sources: Record<string, string> = {
    'README.md': `**Version:** \`${VERSION}\`\n**Status:** Release candidate \`${VERSION}\` - no final public release is declared for this HEAD`,
    'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n**Current source version:** \`${VERSION}\`\n**Release status:** Release candidate; no final public release is declared for the current HEAD.\n\n## [0.1.0-prototype-rc.1] - 2026-05-01`,
    'src/components/layout/AppLayoutV2.tsx': 'v0.1 prototype',
    'src/app/login/page.tsx': 'v0.1 prototype',
    'src/app/signup/page.tsx': 'v0.1 prototype',
    'SECURITY.md': `Radarist \`${VERSION}\` is a release candidate; no final public release is declared for the current HEAD.\n\n| \`${VERSION}\` | yes (showcase only) |`,
    'package-lock.json': JSON.stringify({ version: VERSION, packages: { '': { version: VERSION } } }),
    ...overrides,
  };

  return (file) => {
    const value = sources[file];
    if (value === undefined) throw new Error(`Missing test source: ${file}`);
    return value;
  };
}

describe('validateReleaseIdentity', () => {
  it('accepts a consistent release-candidate identity', () => {
    expect(validateReleaseIdentity(VERSION, makeSources())).toEqual([]);
  });

  it('reports a version banner mismatch', () => {
    const failures = validateReleaseIdentity(
      VERSION,
      makeSources({
        'src/app/login/page.tsx': 'v0.2 prototype',
      })
    );

    expect(failures).toContain(
      'login page prototype chip: found "0.2", expected "0.1"'
    );
  });

  it('rejects a README that presents an RC as a final release', () => {
    const failures = validateReleaseIdentity(
      VERSION,
      makeSources({
        'README.md': `**Version:** \`${VERSION}\`\n**Status:** v0.1.0-prototype - local-first showcase release`,
      })
    );

    expect(failures).toContain(
      `README.md status must identify "${VERSION}" as a release candidate and state that no final public release is declared`
    );
  });

  it('rejects a dated final release while package.json remains an RC', () => {
    const failures = validateReleaseIdentity(
      VERSION,
      makeSources({
        'CHANGELOG.md': `# Changelog\n\n## [0.1.0-prototype] - 2026-07-08\n\n## [Unreleased]\n\n**Current source version:** \`${VERSION}\`\n**Release status:** Release candidate; no final public release is declared for the current HEAD.`,
      })
    );

    expect(failures).toContain(
      `CHANGELOG.md declares final version "0.1.0-prototype" released while package.json is still "${VERSION}"`
    );
    expect(failures).toContain('CHANGELOG.md must put [Unreleased] before dated version entries');
  });

  it('rejects a package-lock root version mismatch', () => {
    const failures = validateReleaseIdentity(
      VERSION,
      makeSources({
        'package-lock.json': JSON.stringify({ version: VERSION, packages: { '': { version: '0.1.0-old' } } }),
      })
    );

    expect(failures).toContain(
      `package-lock.json#packages[""]#version: found "0.1.0-old", expected "${VERSION}"`
    );
  });

  it('accepts a truthful final release from public identity sources alone', () => {
    const finalVersion = '0.1.0-prototype';
    const sources: Record<string, string> = {
      'README.md': `**Version:** \`${finalVersion}\`\n**Status:** Local-first showcase release`,
      'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n**Current source version:** \`${finalVersion}\`\n**Release status:** Final local-first showcase release.\n\n## [${finalVersion}] - 2026-07-10`,
      'src/components/layout/AppLayoutV2.tsx': 'v0.1 prototype',
      'src/app/login/page.tsx': 'v0.1 prototype',
      'src/app/signup/page.tsx': 'v0.1 prototype',
      'SECURITY.md': `Radarist \`${finalVersion}\` is a local-first showcase release.\n\n| \`${finalVersion}\` | yes (showcase only) |`,
      'package-lock.json': JSON.stringify({
        version: finalVersion,
        packages: { '': { version: finalVersion } },
      }),
    };

    expect(
      validateReleaseIdentity(finalVersion, (file) => {
        const value = sources[file];
        if (value === undefined) throw new Error(`Final validation unexpectedly read ${file}`);
        return value;
      })
    ).toEqual([]);
  });
});

function writeFixture(root: string, path: string, contents: string | Buffer): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('validatePublicDocumentation', () => {
  it('discovers every Markdown/HTML file in a public-shaped tree and accepts resolved links', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-docs-'));
    try {
      writeFixture(root, 'README.md', '[Guide](guide.txt)\n<img src="image.png">\n');
      writeFixture(root, 'guide.txt', 'Guide\n');
      writeFixture(root, 'nested/second.html', '<a href="../guide.txt">Guide</a>\n');
      writeFixture(root, 'image.png', pngHeader(12, 8));
      expect(
        validatePublicDocumentation(root, {
          screenshots: [{ path: 'image.png', width: 12, height: 8 }],
        })
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, escaping, and malformed local assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-docs-'));
    try {
      writeFixture(root, 'README.md', '[Missing](missing.txt)\n[Escape](../private.txt)\n');
      writeFixture(root, 'docs/image.png', 'not a png');
      expect(
        validatePublicDocumentation(root, {
          documentationFiles: ['README.md'],
          screenshots: [{ path: 'docs/image.png', width: 1920, height: 1080 }],
        })
      ).toEqual([
        'README.md: local link escapes the repository: ../private.txt',
        'README.md: local link target is missing: missing.txt',
        'docs/image.png: required public screenshot is not a PNG',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
