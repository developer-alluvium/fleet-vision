# ─── Builder Stage ───
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package manifests for workspace dependency resolution
COPY package*.json ./
COPY packages/db/package*.json ./packages/db/
COPY apps/data-processor/package*.json ./apps/data-processor/

RUN npm ci

# Copy sources
COPY packages/db ./packages/db
COPY apps/data-processor ./apps/data-processor
COPY turbo.json ./

# Generate Prisma Client
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma

# ─── Production Runner Stage ───
FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/apps/data-processor ./apps/data-processor

WORKDIR /app/apps/data-processor

CMD ["npm", "run", "start"]
