# Staging rehearsal of the selling flow (PROD-10)

Run this in a **separate staging environment**: its own Fly app, Neon branch and Vercel preview, never pointed at production. Run it on the exact commits picked in [release.md](release.md).

## Automated gate
- [ ] `pnpm exec vitest run --config vitest.e2e.config.ts` is green on the release commit. Point `TEST_DATABASE_URL` at a throwaway database, **never production**.
- [ ] Web CI is green.

## Walk-through (record pass or fail per step)
1. **Onboard:** Platform Console creates a tenant, then the owner accepts the invite, sets up the menu and floor, and enrols devices.
2. **Staff:** add staff and issue PINs. Sign in on an enrolled till. Revoke a PIN and confirm that till is signed out on its next action (#169).
3. **Order:** take a table order and a counter order with modifiers and a combo, and send them to the kitchen.
4. **Kitchen:** tickets appear on the right stations. Start, then Ready; Expo shows it; mark served.
5. **Bill:** split and discount the bill, with a manager PIN over the threshold. Settle with cash plus an external card (reference required).
6. **Refund:** partial refund with a manager PIN; check the credit note on the invoice.
7. **Shift close:** cash count and Z-report. Totals reconcile with the bills and tenders.

## Failure and concurrency cases
- [ ] Two cashiers settle the same bill at the same moment: exactly one succeeds and the other gets a conflict.
- [ ] Double-tap Settle: one tender set, one bill number.
- [ ] Kill the network mid-request, then retry: no duplicate order lines or tenders.
- [ ] Revoke a device mid-shift: it stops, and the other tills carry on.
- [ ] Tenant isolation: staff from tenant A get 404/403 on tenant B's ids.
- [ ] Ten wrong PINs lock that till or address only (#171). An enrolled till elsewhere still signs in.

## Load (sizes the Fly VM)
- [ ] 3 outlets × 4 tills polling KDS/table map, with 30 orders and 30 settlements an hour each. p95 must stay under 500 ms, with no errors and memory under 70% on the Fly VM. If memory goes higher, raise `[[vm]] memory` in `fly.toml`.

## Hardware (needs the devices)
- [ ] The receipt and kitchen printers the venue will use, on the real print path. **Blocked: the printer screen is a simulator today (PROD-05).**
- [ ] Tablets install and update the Android release (PROD-15).

## Rollback rehearsal
- [ ] Deploy, then roll back the API image and the web deployment per [release.md](release.md). The till keeps working (or signs in again) and no data is lost.
