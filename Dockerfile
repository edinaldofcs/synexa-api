# Stage 1: Base & Dependencies
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat gcompat libstdc++ openssl
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
FROM node:22-alpine AS production
RUN apk add --no-cache libc6-compat gcompat libstdc++ openssl curl
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
