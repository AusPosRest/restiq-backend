# Two stages: the compiler and dev packages stay behind in the build stage, so
# the shipped image carries only compiled JavaScript and production packages.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

# Manifests first - Docker caches this layer, so a code change skips the reinstall.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./

# prisma/ and prisma.config.ts before src, and generate before build. src/generated
# is gitignored (Prisma's client is build output, not source), so a fresh clone
# has no client and `npm run build` would die on
# "Cannot find module '../generated/prisma/client.js'". generate needs no
# database - it only reads prisma/schema.prisma - so no build secret is needed.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---- run ----
FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production

# openssl is needed by the Prisma migrate engine (a Rust binary) to reach Neon
# over TLS when fly.toml's release_command runs `prisma migrate deploy` here.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# prisma/ and prisma.config.ts are needed only by release_command
# (`prisma migrate deploy`, run by Fly before the new release takes traffic),
# not by the app itself at boot.
COPY prisma ./prisma
COPY prisma.config.ts ./

# Matches internal_port and PORT in fly.toml.
EXPOSE 8080

# node, not npm: Fly's shutdown signal reaches the process instead of a shell wrapper.
CMD ["node", "dist/index.js"]
