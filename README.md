# restiq-backend

The Restiq API. Express + TypeScript, on Fly.io in Sydney, with Neon Postgres.

Setup and reasoning: the `restiq-design` repo, `setup/` folder.

## Run it

    npm install
    cp .env.example .env      # fill in the values
    npm run dev               # :8180 on the dev machine

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck`.

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
