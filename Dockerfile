# reloadSOL Next.js — multi-stage production image
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
RUN npm ci --ignore-scripts

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_BUILD_CHECKS=true
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache wget \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]

# ===== Development target (hot reload) =====
FROM node:20-alpine AS development
WORKDIR /app
RUN apk add --no-cache libc6-compat python3 make g++ wget
COPY package.json package-lock.json* .npmrc ./
RUN npm ci --ignore-scripts
COPY . .
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
COPY scripts/docker-dev-entrypoint.sh /usr/local/bin/docker-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-dev-entrypoint.sh
CMD ["/usr/local/bin/docker-dev-entrypoint.sh"]
