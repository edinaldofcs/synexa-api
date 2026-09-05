# Stage 1: Base & Dependencies
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: Development (Watch mode)
FROM base AS development
ENV NODE_ENV=development
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Stage 3: Builder
FROM base AS builder
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --production

# Stage 4: Production Run
FROM node:22-bookworm-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -r nodejs && useradd -r -g nodejs nestjs
WORKDIR /app
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
RUN mkdir -p /app/uploads && chown -R nestjs:nodejs /app/uploads
ENV NODE_ENV=production
USER nestjs
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
