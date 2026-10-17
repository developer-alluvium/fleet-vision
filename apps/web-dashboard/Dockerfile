# ─── Builder Stage ───
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package manifests for workspace dependency resolution
COPY package*.json ./
COPY packages/db/package*.json ./packages/db/
COPY apps/web-dashboard/package*.json ./apps/web-dashboard/

RUN npm ci

# Copy sources
COPY packages/db ./packages/db
COPY apps/web-dashboard ./apps/web-dashboard
COPY turbo.json ./

# Generate Prisma Client
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma

# Build Next.js application and API routes
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build -w web-dashboard

# ─── Production Runner Stage ───
FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/apps/web-dashboard ./apps/web-dashboard

WORKDIR /app/apps/web-dashboard

EXPOSE 3000

CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
