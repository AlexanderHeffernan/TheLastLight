FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ARG BUILD_TIMESTAMP
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY --chown=node:node src ./src
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public

RUN npm ci && npm run build && npm prune --omit=dev
RUN mkdir -p /data && chown node:node /data

FROM node:20-alpine

WORKDIR /app

ARG BUILD_TIMESTAMP
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /data /data

ENV NODE_ENV=production
ENV DATA_DIR=/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/status >/dev/null || exit 1

CMD ["node", "dist/server/index.js"]
