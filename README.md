# restiq-backend

The Restiq API. Express + TypeScript, on Fly.io in Sydney, with Neon Postgres.

Setup and reasoning: the `restiq-design` repo, `setup/` folder.

## Where it runs

    dev    https://api.restiqdev.idelta.com.au    Caddy -> .40:8180
    prod   https://api.restiq.idelta.com.au       Fly, syd

Both become `api.restiq.com.au` when the real domain arrives. No code change -
the address lives in an environment variable.

## Run it

    npm install
    cp .env.example .env      # fill in the values
    npm run db:generate       # writes the Prisma client into src/generated (gitignored)
    npm run dev               # :8180 on the dev machine

## Database

Prisma, via `@prisma/adapter-pg`, is the only thing that talks to Postgres -
both for the running app (`src/db/client.ts`) and for building the database's
shape. `prisma/schema.prisma` ships with zero models - there is no design doc
for restiq's data yet. Add tables there once the domain is designed.

    npm run db:generate    # regenerate the client after editing schema.prisma
    npm run db:migrate     # prisma migrate deploy - apply migrations

To add a migration after changing `prisma/schema.prisma`:

    mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<name>
    npx prisma migrate diff \
      --from-config-datasource \
      --to-schema prisma/schema.prisma \
      --script > prisma/migrations/<the directory you just made>/migration.sql
    npm run db:migrate

Why `migrate diff` + `migrate deploy` and not `migrate dev`: the `restiq` role
is deliberately not a superuser (Neon gives none in prod, so a migration that
needs one would pass here and fail there) and cannot create the shadow
database `migrate dev` needs. Full reasoning:
`restiq-design/setup/04-prisma-setup.md`.

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck`, `db:generate`, `db:migrate`.

CI runs lint, typecheck and build on every PR into `main`.

## Routes

    GET /health      {"status":"ok","service":"restiq-backend"}
    GET /health/db   200 when the database answers, 503 when it does not

`GET /` is a 404. Only these two exist; the site lives on Vercel.

## Environment

All addresses come from the environment - no hostname is written in source.
Keys are listed in `.env.example`.

## Deploy

    fly deploy

Use the CLI, not Fly's web launch UI.
tetsings