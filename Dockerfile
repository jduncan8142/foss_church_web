# FOSS Church marketing site — Bun runtime, no build step (Bun runs TS directly).
# Multi-stage so the runtime image carries only production deps + app code.

# ---- deps: resolve production dependencies against the committed lockfile ----
FROM oven/bun:1.3.11-slim AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1.3.11-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    FC_DATA_DIR=/app/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

# Lead log lives here (bind-mounted in compose); owned by the unprivileged bun user.
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "run", "src/server.ts"]
