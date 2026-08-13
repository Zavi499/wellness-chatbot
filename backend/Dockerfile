# ---------------------------------------------------------------------------
# Wellness World chatbot backend
#
# Multi-stage: dev dependencies and TypeScript sources stay in the build stage,
# so the published image carries only compiled output and runtime dependencies.
#
# Node 24 is required, not merely preferred: the service uses Node's built-in
# `node:sqlite`, which needs >= 22.5.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS build

WORKDIR /app

# Dependencies first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# Compiles to dist/ and copies schema.sql + the questionnaire configs alongside
# it, so dist/ needs nothing from src/ at runtime.
RUN npm run build


FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
# Default inside the container. Mount a persistent volume here — everything the
# store cannot regenerate (verification decisions, FAQ, escalations) lives in it.
ENV DATABASE_PATH=/app/data/wellness-chatbot.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# `node` is an unprivileged user that ships with the base image.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787

# Node 24 has global fetch, so this needs no extra package in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
