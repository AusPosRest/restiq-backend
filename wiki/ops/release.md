# Release freeze and rollout (PROD-06)

1. **Refresh and reconcile.** Run `git fetch` in restiq-web, restiq-backend and restiq-android. Every change meant for the release is merged to `main` through a PR with green CI. Nothing ships from `local-integration`.
2. **Pick the commits.** Record the web, API and Android SHAs in the release notes, and check that each SHA's CI run is green:
   ```
   gh run list --commit <sha>
   ```
3. **Tag them:** `git tag -a vYYYY.MM.DD -m "<summary>"` in each repo, then push the tags.
4. **Schema and API compatibility.**
   - List the migrations in the release (`prisma/migrations/*` since the last tag).
   - Every one must be additive (new tables, columns or indexes).
   - A destructive change ships in two releases: first expand, then contract.
5. **Order:**
   1. The API first. Fly runs `prisma migrate deploy` as its release command, and machines roll only if it succeeds.
   2. Then the web.
   3. Then Android, if its origin or asset links changed.
6. **Rollback.**
   - Web: redeploy the previous Vercel deployment.
   - API: `fly deploy --image <previous image>`. Get the image from `fly releases -a restiq-backend --image`.
   - Additive migrations don't need rolling back. The old code ignores new columns.
7. **Smoke test after deploy:**
   - `/health` and `/health/db` return 200;
   - a POS PIN sign-in, an order to the KDS, a cash settlement and a Z-report on the pilot tenant.
