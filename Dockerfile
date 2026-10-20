# Verified Node 26.12.0 image; pin the manifest so a deployment cannot silently change runtimes.
ARG NODE_IMAGE=node:26-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY test ./test
COPY index.html vite.config.ts tsconfig.json ./
RUN npm test && npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ARG REVISION=development
LABEL org.opencontainers.image.source="https://github.com/sergkhl/flipper"
LABEL org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production FLIPPER_REVISION=${REVISION}
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist
USER node
COPY --chown=node:node LICENSE NOTICE.md ./
CMD ["node", "--import", "tsx", "server/index.ts"]
