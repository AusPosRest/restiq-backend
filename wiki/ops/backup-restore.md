# Backup, restore and migration safety (PROD-08)

Targets from the product plan are **RPO 5 min** and **RTO 2 h**.

## Verify the settings (Neon console)
- [ ] Project settings → **History retention** is at least 7 days, which is what point-in-time restore covers.
- [ ] The plan provides the 35-day backup target. If not, schedule a nightly `pg_dump` to object storage, or revise the target in the plan.
- [ ] Name who owns restores and who can approve one.

## Restore drill (do quarterly and before launch; record the result)
1. Note the time T and a recent known transaction, such as the last finalized bill number per outlet.
2. In Neon, create a **branch from a point in time** (T minus 5 minutes) of the production branch. This never touches production.
3. Point a scratch API at that branch. Use a staging Fly app, or run it locally with `DATABASE_URL=<branch url>`.
4. Validate:
   - bills, tenders, credit notes and `audit_events` up to T minus 5 minutes are present;
   - bill numbers are gapless per outlet;
   - the shift totals reconcile.
5. Record the time taken end to end (the RTO) and the data gap (the RPO) in the drill log below. Then delete the branch.

## Migrations
- Every migration is additive (see [release.md](release.md) step 4).
- Before a release, apply the new migrations to a **copy of production** (a Neon branch) and run the smoke test there.
- If a migration fails in the Fly release command, the machines keep the old version. Fix forward with a new migration and never hand-edit production.

## Drill log
| Date | Who | Point restored | RTO | RPO | Notes |
|---|---|---|---|---|---|
