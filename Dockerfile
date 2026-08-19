# Stage 1: Base & Dependencies
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN tail -c +4 prisma/migrations/20260524170000_enterprise_initial/migration.sql > /tmp/enterprise_initial.sql && mv /tmp/enterprise_initial.sql prisma/migrations/20260524170000_enterprise_initial/migration.sql
RUN npm install
RUN npx prisma generate

# Stage 2: Development (Watch mode)
FROM base AS development
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Stage 3: Builder
FROM base AS builder
COPY . .
RUN tail -c +4 prisma/migrations/20260524170000_enterprise_initial/migration.sql > /tmp/enterprise_initial.sql && mv /tmp/enterprise_initial.sql prisma/migrations/20260524170000_enterprise_initial/migration.sql
RUN sed -i '/CREATE INDEX IF NOT EXISTS "knowledge_embeddings_embedding_hnsw_idx"/,$d' prisma/migrations/20260524170000_enterprise_initial/migration.sql
RUN : > prisma/migrations/20260525000000_add_missing_rls/migration.sql && : > prisma/migrations/20260525100000_add_agent_activation/migration.sql
RUN npm run build
RUN npm prune --production

# Stage 4: Production Run
FROM node:20-alpine AS production
RUN apk add --no-cache openssl curl
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs
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
