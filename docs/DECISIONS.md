# Architecture decisions

## 2026-11-14 - The offline hub runs this backend (option A) - #293

Restiq `docs/HUB-BUILD-PLAN.md` §1.

**Decision:** the Windows hub till runs a "hub mode" build of restiq-backend (`src/hub/`) on PGlite, bundled as `dist-hub/hub.cjs`, instead of a hand-written service in restiq-desktop (option B).

**Why:**
- The POS and KDS screens call about 50 routes whose services (orders, lines, bills, bill-core, tax, kitchen tickets, menu, shifts) are ~3,000 lines plus their view shapes; a port would be a second money path (breaks AD-18) and drift forever.
- The PGlite spike (restiq-desktop#3) ran every migration, RLS and Prisma 7 unchanged, so the hub runs the same code the cloud does; a backend PR that breaks the hub fails `pnpm test`.
- Every service already reaches the database through `RegionRegistryService` → `PrismaService` → `getPrisma()`, so one `setPrismaClient()` swaps in PGlite.
- Cost: a cross-repo build artifact for desktop CI, and an allowlist to keep the hub surface to POS and KDS.
