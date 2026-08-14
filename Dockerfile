# Stage 1: Install dependencies
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Stage 2: Build the application
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env vars (placeholders for build — real values provided at runtime)
ENV NEXT_PUBLIC_FIREBASE_API_KEY=placeholder
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=placeholder
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=placeholder
ENV NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=placeholder
ENV NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=placeholder
ENV NEXT_PUBLIC_FIREBASE_APP_ID=placeholder

# Invoke Next directly: the Docker context omits public-documentation inputs,
# so the capability-catalog prebuild must not run here. The app consumes the
# committed generated catalog; the product runtime plugin is copied separately
# into agent/dist by `setup:agents` below.
RUN ./node_modules/.bin/next build

# OPS-004: build the mission runtime INTO the image. The in-process worker
# (Inngest, inside this app) dynamically imports agent/dist/orchestrator-lite.js
# and resolves the Claude Agent SDK from agent/node_modules; without these,
# every mission fails at orchestrator load. `setup:agents` runs `npm ci` in
# agent/ and compiles agent/dist (the Dockerfile can't use `npm run build`,
# which the capability-catalog prebuild would break here, so this is explicit).
RUN npm run setup:agents

# Stage 3: Production runner
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=9002
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# OPS-004: ship the mission runtime the in-process worker loads. agent-import.ts
# resolves these relative to process.cwd() (/app): /app/agent/dist (compiled
# orchestrator), /app/agent/node_modules (Claude Agent SDK), /app/agent/agents
# (PROFILE.md + config.yaml the orchestrator reads at runtime). The product
# analytical-skill plugin is contained inside agent/dist/runtime-plugin.
COPY --from=builder --chown=nextjs:nodejs /app/agent/dist ./agent/dist
COPY --from=builder --chown=nextjs:nodejs /app/agent/node_modules ./agent/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/agent/agents ./agent/agents

USER nextjs

EXPOSE 9002

CMD ["node", "server.js"]
