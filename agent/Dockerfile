# =============================================================================
# Impulse Agent Runtime — Multi-stage Dockerfile
# =============================================================================
# Build context: agent/ (set via docker-compose build.context: ./agent)
# Usage:
#   docker build -t impulse-agent agent/
#   docker run impulse-agent --mission scout
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Install production dependencies only
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript (needs devDependencies for tsc)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
COPY runtime-plugin/ ./runtime-plugin/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: Production runner
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="Impulse Agent Runtime"
LABEL org.opencontainers.image.description="Claude Agent SDK orchestrator with SENSE-DECIDE-ACT-REFLECT sweep loop"
LABEL org.opencontainers.image.source="https://github.com/radarist/radarist"

ENV NODE_ENV=production

# Non-root user for security
RUN addgroup --system --gid 1001 impulse && \
    adduser --system --uid 1001 --ingroup impulse agent

# Production dependencies (no devDeps)
COPY --from=deps /app/node_modules ./node_modules

# Compiled output
COPY --from=builder /app/dist ./dist

# Package metadata (needed for ESM resolution)
COPY package.json ./

# Agent profiles — PROFILE.md + config.yaml files needed at runtime
COPY agents/ ./agents/

# Set ownership for the non-root user
RUN chown -R agent:impulse /app

USER agent

ENTRYPOINT ["node", "dist/index.js"]
