/** @jest-environment node */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

describe('Docker build capability-catalog contract', () => {
  it('builds from the committed catalog without invoking ignored generator inputs', () => {
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
    const dockerignore = readFileSync(resolve(ROOT, '.dockerignore'), 'utf8');
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const generatedCatalog = resolve(ROOT, 'src/lib/ai/capability-catalog.generated.ts');

    expect(packageJson.scripts?.prebuild).toContain('generate-capability-catalog.ts');
    expect(dockerignore).toMatch(/^docs$/m);
    expect(dockerignore).toMatch(/^\*\.md$/m);
    // OPS-004: the mission worker dynamically imports the agent runtime from
    // the deployed image. Keep host artifacts out, but never exclude the whole
    // package or its profile assets from the builder context.
    expect(dockerignore).not.toMatch(/^agent$/m);
    expect(dockerignore).toMatch(/^agent\/node_modules$/m);
    expect(dockerignore).toMatch(/^agent\/dist$/m);
    expect(dockerignore).toMatch(/^!agent\/agents\/\*\*$/m);
    expect(dockerignore).toMatch(/^\.claude$/m);
    expect(dockerignore).toMatch(/^!agent\/runtime-plugin\/\*\*$/m);
    expect(dockerignore).toMatch(/^jest-results\*\.json$/m);
    expect(dockerfile).toContain('RUN ./node_modules/.bin/next build');
    expect(dockerfile).not.toMatch(/^RUN npm run build\s*$/m);
    expect(dockerfile).toContain('RUN npm run setup:agents');
    expect(dockerfile).toContain('/app/agent/dist ./agent/dist');
    expect(dockerfile).toContain('/app/agent/node_modules ./agent/node_modules');
    expect(dockerfile).toContain('/app/agent/agents ./agent/agents');
    expect(existsSync(generatedCatalog)).toBe(true);
    expect(readFileSync(generatedCatalog, 'utf8')).toContain('GENERATED FILE');
  });

  it('packages the product plugin without advertising non-runtime source metadata', () => {
    const agentDockerfile = readFileSync(resolve(ROOT, 'agent/Dockerfile'), 'utf8');
    expect(agentDockerfile).toContain('COPY runtime-plugin/ ./runtime-plugin/');
    expect(agentDockerfile).toContain('org.opencontainers.image.source="https://github.com/radarist/radarist"');
    expect(agentDockerfile).not.toMatch(/nicober|radarist-studio/);
  });

  it('keeps the public sandbox-image command self-contained', () => {
    const builder = readFileSync(resolve(ROOT, 'scripts/build-sandbox-image.ts'), 'utf8');
    expect(builder).toContain('Sandbox image is ready for build missions.');
    expect(builder).not.toMatch(/scripts\/run-build-sandbox|docs\/testing\/build-mission-briefs/);
  });

  it('keeps the runtime postbuild hook provider-neutral and self-contained', () => {
    const postbuild = readFileSync(resolve(ROOT, 'scripts/postbuild-agent-runtime.mjs'), 'utf8');
    expect(postbuild).toContain("process.env.BUILD_AGENT_RUNTIME !== '1'");
    expect(postbuild).toContain("['run', 'setup:agents']");
    expect(postbuild).not.toMatch(/apphosting\.ya?ml|App Hosting/);
  });
});
