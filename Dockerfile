FROM node:24-slim AS base

FROM base AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild sharp unrs-resolver

FROM base AS migrate-deps
WORKDIR /deps
COPY scripts/install-migrate-deps.mjs ./
# Copied under a non-manifest name on purpose: if this lands as /deps/package.json,
# `npm install` also pulls in every dependency AND devDependency it declares
# (drizzle-kit, jsdom, babel, ...), baking ~750 packages and vulnerable esbuild
# Go binaries into the runtime image. The migrate stage needs drizzle-orm + pg only.
COPY package.json ./app-package.json
RUN node install-migrate-deps.mjs

# Receipt OCR runtime. Installed flat with npm instead of traced out of the pnpm
# layout: the standalone trace copies tesseract.js and @napi-rs/canvas without
# their nested dependencies or the platform-specific native binding, so they fail
# to load. Versions match package.json; loaded via OCR_MODULES_DIR (lib/receipts/ocr.ts).
FROM base AS ocr-deps
WORKDIR /ocr
RUN npm init -y >/dev/null && \
    npm install --omit=dev --no-audit --no-fund --save-exact \
      tesseract.js@7.0.0 @tesseract.js-data/eng@1.0.0 @napi-rs/canvas@1.1.0

FROM base AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runner
# Upgrade first: the node:*-slim tag lags Debian security updates, and the
# release gate fails on any fixable CRITICAL (perl-base blocked v0.3.3).
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
# The runtime is pure node (entrypoint runs migrate.mjs then server.js), so npm
# is dead weight that only widens the attack surface — its bundled dependencies
# are a recurring source of CVEs in image scans. Drop it from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The official MCP registry reads this label to confirm the image belongs to
# the server it is published under. It must sit in the final stage.
LABEL io.modelcontextprotocol.server.name="io.github.KenTaniguchi-R/ledgr"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next && chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY --from=builder /app/src/db/migrations ./migrations
COPY --from=builder /app/scripts/migrate.mjs ./migrations/migrate.mjs
COPY --from=builder /app/scripts/ensure-app-role.mjs ./migrations/ensure-app-role.mjs
COPY --from=migrate-deps /deps/node_modules ./migrations/node_modules
COPY --from=ocr-deps --chown=nextjs:nodejs /ocr/node_modules ./ocr_modules/node_modules
ENV OCR_MODULES_DIR=/app/ocr_modules
COPY --from=builder --chmod=755 /app/scripts/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder --chmod=755 /app/scripts/ensure-secrets.sh ./ensure-secrets.sh

# App data volume mount point (auto-generated secrets). Owned by the runtime
# user so Docker named volumes initialize with writable permissions.
RUN mkdir /data && chown nextjs:nodejs /data

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["tini", "--"]
CMD ["./docker-entrypoint.sh"]
