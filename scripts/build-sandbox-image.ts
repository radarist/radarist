/**
 * Build the build-mission sandbox OCI image from the agent template.
 *
 *   npx tsx scripts/build-sandbox-image.ts
 *
 * Image name/tag come from IMPULSE_BUILD_SANDBOX_IMAGE / _IMAGE_TAG
 * (defaults radarist-build-sandbox:v2). Bump the tag whenever the template
 * (skills, hooks, Dockerfile, pinned Claude Code version) changes — the tag
 * is the methodology pack's version.
 */
import './load-env-local';
import { spawn } from 'child_process';
import * as path from 'path';

const image = process.env.IMPULSE_BUILD_SANDBOX_IMAGE || 'radarist-build-sandbox';
const tag = process.env.IMPULSE_BUILD_SANDBOX_IMAGE_TAG || 'v2';
const templateDir = path.resolve('agent', 'src', 'sandbox', 'template');

console.log(`Building ${image}:${tag} from ${templateDir} …`);
const child = spawn(
  'docker',
  ['build', '-t', `${image}:${tag}`, '-f', path.join(templateDir, 'Dockerfile'), templateDir],
  { stdio: 'inherit' }
);
child.on('exit', (code) => {
  if (code === 0) {
    console.log(`\n✅ Built ${image}:${tag}`);
    console.log('Sandbox image is ready for build missions.');
  }
  process.exit(code ?? 1);
});
