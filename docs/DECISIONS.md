# Architecture decisions

## 2026-11-21 - Operators may hold an admin-realm token in service mode (amends AD-10) - #314

**Decision:** an operator can open one restaurant's owner console through an audited, address-bound handoff: ops mints a 60 s code (admin secret, audience `admin-handoff`), the web server redeems it at `<slug>.<base domain>` for a 1 h admin token marked `svc` with the operator as subject.

**Why:**
- Support needs to see and fix what the owner sees without the owner's password; owner sessions are bound to the restaurant's address, so the ops console cannot set that cookie itself.
- The realms stay disjoint in signing: an ops token is still never accepted on `/admin/*`; the service token is an admin token, bound to one tenant and to the operator's own sessionVersion (ops logout ends it).
- Every start is audited with a reason on the tenant and in the control plane (a deliberate exception to AD-8's "never both": it is a tenant action and the operator taking on a session); work in the session is audited as the operator.
- Owner-only actions (signing, paying, ending the owner's sessions) are refused with `@OwnerOnly()`.
- The code is a signed token, not a stored row: replay inside 60 s is accepted as a known ceiling; add a table if that or a session list ever matters.

## 2026-11-14 - The offline hub runs this backend (option A) - #293

Restiq `docs/HUB-BUILD-PLAN.md` §1.

**Decision:** the Windows hub till runs a "hub mode" build of restiq-backend (`src/hub/`) on PGlite, bundled as `dist-hub/hub.cjs`, instead of a hand-written service in restiq-desktop (option B).

**Why:**
- The POS and KDS screens call about 50 routes whose services (orders, lines, bills, bill-core, tax, kitchen tickets, menu, shifts) are ~3,000 lines plus their view shapes; a port would be a second money path (breaks AD-18) and drift forever.
- The PGlite spike (restiq-desktop#3) ran every migration, RLS and Prisma 7 unchanged, so the hub runs the same code the cloud does; a backend PR that breaks the hub fails `pnpm test`.
- Every service already reaches the database through `RegionRegistryService` → `PrismaService` → `getPrisma()`, so one `setPrismaClient()` swaps in PGlite.
- Cost: a cross-repo build artifact for desktop CI, and an allowlist to keep the hub surface to POS and KDS.
