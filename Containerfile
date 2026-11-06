# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.6.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DSH_HOME=/data \
    DSH_TELEMETRY_DISABLED=1
WORKDIR /workspace
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace
USER node
VOLUME ["/data", "/workspace"]
ENTRYPOINT ["node", "/app/apps/cli/lib/bin.js", "--profile", "acp"]
CMD []
