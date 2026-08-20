# Two stages: the compiler and dev packages stay behind in the build stage, so
# the shipped image carries only compiled JavaScript and production packages.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

# Manifests first - Docker caches this layer, so a code change skips the reinstall.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- run ----
FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Matches internal_port and PORT in fly.toml.
EXPOSE 8080

# node, not npm: Fly's shutdown signal reaches the process instead of a shell wrapper.
CMD ["node", "dist/index.js"]
