FROM node:20-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ─── Build ────────────────────────────────────────────────────────────────────
FROM base AS build

# Copy pre-built node_modules from local install (built outside Docker)
COPY kai-execution-api/node_modules kai-execution-api/node_modules
COPY kai-execution-api/dist kai-execution-api/dist
COPY kai-execution-api/package.json kai-execution-api/package.json

# Prisma schema and client (shared with kai-backend)
COPY kai-backend/backend-kai/prisma kai-backend/backend-kai/prisma
COPY kai-execution-api/node_modules/.prisma kai-execution-api/node_modules/.prisma

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/kai-execution-api /app/kai-execution-api
COPY --from=build /app/kai-backend/backend-kai/prisma /app/kai-backend/backend-kai/prisma

# Re-install only production deps (in case the dev deps bloat the image)
RUN cd /app/kai-execution-api && npm prune --omit=dev --legacy-peer-deps 2>&1 || true

WORKDIR /app/kai-execution-api
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
