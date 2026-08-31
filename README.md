# restiq-backend

The Restiq API. NestJS 11 + Prisma 7 + TypeScript, on Fly.io in Sydney, with
Neon Postgres. A modular monolith: one Nest module per bounded context, cross-
module imports only through each module's `index.ts` barrel (lint-enforced).

Setup and reasoning: the `restiq-design` repo, `setup/` folder. Architecture:
`restiq-design/docs/architecture/architecture-Restiq-2026-08-24/ARCHITECTURE-SPINE.md`.

## Where it runs

    dev    https://api.restiqdev.idelta.com.au    Caddy -> .40:8180
    prod   https://api.restiq.idelta.com.au       Fly, syd

Both become `api.restiq.com.au` when the real domain arrives. No code change -
the address lives in an environment variable.

## Run it

    pnpm install
    cp .env.example .env      # fill in the values
    pnpm run db:generate      # writes the Prisma client into src/generated (gitignored)
    pnpm run dev              # :8180 on the dev machine

## Layout

    src/main.ts        Nest bootstrap
    src/platform/      cross-cutting: Prisma service, ops auth guard, control-plane audit writer
    src/ops/           console API (internal operators): /ops/v1/...
    src/db/            Prisma client construction (DATABASE_URL via @prisma/adapter-pg)

## Auth realms

Two disjoint realms by construction: operator tokens carry `aud: "ops"` and are
signed with `OPS_JWT_SECRET`; the (future) tenant realm gets its own secret and
`aud: "tenant"`. A global guard on the `/ops/*` prefix accepts only ops-realm
tokens. Operator logins/logouts are audited into `control_plane_audit_events`
(append-only).

Seed the first operator (credentials from env, never from source):

    OPERATOR_EMAIL=you@restiq.example OPERATOR_PASSWORD='...' pnpm run seed:operator

## Database

Prisma, via `@prisma/adapter-pg`, is the only thing that talks to Postgres -
both for the running app (`src/db/client.ts`) and for building the database's
shape.

    pnpm run db:generate    # regenerate the client after editing schema.prisma
    pnpm run db:migrate     # prisma migrate deploy - apply migrations

To add a migration after changing `prisma/schema.prisma`:

    mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<name>
    pnpm exec prisma migrate diff \
      --from-config-datasource \
      --to-schema prisma/schema.prisma \
      --script > prisma/migrations/<the directory you just made>/migration.sql
    pnpm run db:migrate

Why `migrate diff` + `migrate deploy` and not `migrate dev`: the `restiq` role
is deliberately not a superuser (Neon gives none in prod, so a migration that
needs one would pass here and fail there) and cannot create the shadow
database `migrate dev` needs. Full reasoning:
`restiq-design/setup/04-prisma-setup.md`.

## Tests

    pnpm run test        # unit (vitest)
    pnpm run test:e2e    # supertest against TEST_DATABASE_URL - wipes that db, never dev

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e`,
`db:generate`, `db:migrate`, `seed:operator`.

CI runs lint, typecheck, unit + e2e tests and build on every PR into `main`
or `dev`.

## Routes

    GET  /health                {"status":"ok","service":"restiq-backend"}
    GET  /health/db             200 when the database answers, 503 when it does not
    POST /ops/v1/auth/login     email+password -> { token, operator }; generic 401 on bad credentials
    GET  /ops/v1/auth/session   current operator (Bearer token)
    POST /ops/v1/auth/logout    204; audited

Errors are shaped `{ "error": { "code", "message" } }`.

## Environment

All addresses come from the environment - no hostname is written in source.
Keys are listed in `.env.example`.

## Deploy

    fly deploy

Use the CLI, not Fly's web launch UI.
