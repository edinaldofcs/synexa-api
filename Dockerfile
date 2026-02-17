# Stage 1: Build
FROM node:20-alpine AS builder

# Install necessary build tools and openssl
RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

# Copy lock files and prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies (including devDependencies)
# Using npm ci for reliable, reproducible builds
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy the rest of the application  
COPY . .

# Build the application
RUN npm run build

# Remove devDependencies to keep the image slim
RUN npm prune --production

# Stage 2: Production
# Stage 2: Production
FROM node:20-alpine

# Install openssl for Prisma
RUN apk add --no-cache openssl

# Use a non-root user for security
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs

WORKDIR /app

# Copy necessary files from builder stage
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma

# Set production environment
ENV NODE_ENV=production

# Switch to non-root user
USER nestjs

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "dist/main"]
