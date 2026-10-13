FROM node:24-trixie-slim AS build
WORKDIR /app
# Longbridge 5.2.0 Linux x64 requires GLIBC_2.39; trixie supplies a compatible runtime.
# Native SQLite bindings can fall back to a source build on the target CPU.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:24-trixie-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PULLBACK_DB=/app/data/pullback.sqlite \
    PULLBACK_DEMO=0 PULLBACK_MARKET_WORKER=0
WORKDIR /app
COPY --from=build /app/package*.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# Loading the pinned native SDK is a platform check only; no credentials or network context.
RUN node --input-type=module -e "const sdk = await import('longbridge'); if (typeof sdk.QuoteContext?.new !== 'function') process.exit(1)"
EXPOSE 3000
# A missing market-data entitlement is not a dead process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health', { signal: AbortSignal.timeout(4000) }); if (!r.ok || (await r.json()).ok !== true) process.exit(1); } catch { process.exit(1); }"]
CMD ["node", "--import", "tsx", "apps/server/main.ts"]
