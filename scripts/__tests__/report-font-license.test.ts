/** @jest-environment node */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CSS_PATH = resolve(ROOT, 'public/css/report-brand.css');

const EXPECTED_FACES = new Map([
  ['Inter 400', '48a0c2503a9c8ec4153302693fff56b3281aba5ce5afd7cf2bd51a03b098cd22'],
  ['Inter 600', '9a3d22c43636255dd1d3c910c534e1b55ecdcaf074ffa013971fad0d4d32f031'],
  ['Inter 800', '713403e7d227a0fc231322cbd70e46601ceda4a514f08d19896a3029c2eefed9'],
  ['Playfair Display 700', '02af2688dd8c8a55069e99bba3f5c70c67c8f7fb0b7fca9c4fc40c4ffc474d06'],
  ['Playfair Display 800', '9d293c073e0f3b3e2e7954e531506ab6499bd273a6ae0bf7de1fa10468112ed9'],
]);

function embeddedFaceHashes(css: string): Map<string, string> {
  const faces = new Map<string, string>();
  const fontBlock = css.slice(css.indexOf('/* FONTS:BEGIN'), css.indexOf('/* FONTS:END */'));
  const facePattern =
    /@font-face\s*\{[\s\S]*?font-family:\s*'([^']+)'[\s\S]*?font-weight:\s*(\d+)[\s\S]*?base64,([A-Za-z0-9+/=]+)[\s\S]*?\}/g;

  let match: RegExpExecArray | null;
  while ((match = facePattern.exec(fontBlock)) !== null) {
    const bytes = Buffer.from(match[3], 'base64');
    faces.set(`${match[1]} ${match[2]}`, createHash('sha256').update(bytes).digest('hex'));
  }
  return faces;
}

describe('bundled report font license contract', () => {
  it('pins the five audited WOFF2 payload receipts', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    expect(embeddedFaceHashes(css)).toEqual(EXPECTED_FACES);
  });

  it('keeps the complete OFL and both copyright notices with the redistributed bytes', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const generatedEnd = css.indexOf('/* FONTS:END */');
    const noticeStart = css.indexOf('Bundled font notices');

    expect(generatedEnd).toBeGreaterThan(0);
    expect(noticeStart).toBeGreaterThan(generatedEnd);
    expect(css).toContain('Copyright 2020 The Inter Project Authors');
    expect(css).toContain('Copyright 2017 The Playfair Display Project Authors');
    expect(css).toContain('Reserved Font Name');
    expect(css).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(css).toContain('PERMISSION & CONDITIONS');
    expect(css).toContain('TERMINATION');
    expect(css).toContain('DISCLAIMER');
  });

  it('keeps the standalone license and third-party receipt aligned', () => {
    const license = readFileSync(resolve(ROOT, 'LICENSES/SIL-OFL-1.1.txt'), 'utf8');
    const notices = readFileSync(resolve(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');

    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(license).toContain('PERMISSION & CONDITIONS');
    expect(license).toContain('TERMINATION');
    expect(license).toContain('DISCLAIMER');
    for (const [face, hash] of EXPECTED_FACES) {
      expect(notices).toContain(face);
      expect(notices).toContain(hash);
    }
  });
});
