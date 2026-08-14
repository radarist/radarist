# Build-mission sandbox image.
# Build with: npx tsx scripts/build-sandbox-image.ts  (from the repo root)
# Bumping IMPULSE_BUILD_SANDBOX_IMAGE_TAG is the contract re-verification
# ritual: the pinned Claude Code version below defines the stream-json
# parser contract (agent/src/sandbox/stream-json.ts, fixture-tested).
FROM node:22-bookworm

# Phase 0 validated against this exact CLI version.
ARG CLAUDE_CODE_VERSION=2.1.172
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq procps coreutils util-linux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" pnpm

# Published previews run under a separate identity from the build agent. The
# retained /workspace volume is mode 0700/node while the reviewed disposable
# copy is owned by this user, so application code cannot read agent state.
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin preview

# Pre-warm a chromium + system deps so mission Playwright runs don't start
# with a 200MB download. Missions installing a different @playwright/test
# version may still fetch their matching browser build — that's acceptable.
RUN npx -y playwright@latest install --with-deps chromium

# Methodology template — copied into the workspace volume on first start.
COPY skills /opt/impulse/template/skills
COPY hooks /opt/impulse/template/hooks
# Task 6 visual gate: invoked from this baked image path directly by
# runVisualGate() — NOT seeded into the workspace volume by entrypoint.sh,
# so it survives resume/iterate on volumes provisioned after this image.
COPY scripts /opt/impulse/template/scripts
COPY settings.json workspace.gitignore /opt/impulse/template/
COPY entrypoint.sh /usr/local/bin/impulse-entrypoint.sh
RUN chmod +x /usr/local/bin/impulse-entrypoint.sh /opt/impulse/template/hooks/*.sh

# Sessions run as the unprivileged node user: Claude Code refuses
# --dangerously-skip-permissions under root, and least-privilege is right
# anyway. The workspace dir is chowned in-image so the named volume
# inherits node ownership on first mount.
RUN mkdir -p /workspace && chown -R node:node /workspace /opt/impulse /opt/ms-playwright
USER node

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/impulse-entrypoint.sh"]
CMD ["sleep", "infinity"]
