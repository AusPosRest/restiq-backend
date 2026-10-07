# Launch configuration checklist (PROD-11)

The API refuses to boot in production when any setting below is missing or unsafe (`src/platform/production-config.ts`), listing all of them at once. This checklist covers what the boot check **can't** see.

## Fly (`fly secrets list -a restiq-backend`)
- [ ] `DATABASE_URL` points at the **production** Neon branch, pooled endpoint.
- [ ] `OPS_JWT_SECRET`, `ADMIN_JWT_SECRET`, `POS_JWT_SECRET`, `GUEST_JWT_SECRET`: all different and at least 32 random characters. Generate each with `openssl rand -base64 48`.
- [ ] `PROXY_SHARED_SECRET`: at least 32 characters. **Vercel's `PROXY_SHARED_SECRET` must have the same value.**
- [ ] `WEB_ORIGIN`: the production web origin, https.
- [ ] `HOME_REGION`: must equal the region the existing tenants are registered in.
  - Check with `SELECT region, count(*) FROM tenant_registry GROUP BY region;`, which should give one row.
  - Setting a different value strands every existing tenant: `planeFor` throws.
- [ ] `ALERT_WEBHOOK_URL`: the incoming-webhook URL of the on-call channel (see [alerts.md](alerts.md)).
- [ ] `fly.toml [env]` already pins `PAYMENTS_SIMULATOR=off` and `TRUST_PROXY_HOPS=1`. Don't override either as a secret.

## Region and data placement
- [ ] The Fly `primary_region` (`syd`) is close to the Neon region. Check it in the Neon console under Project settings, then Region.
- [ ] The data location matches what the market's customer terms promise (AU / IN). **This is a business or legal check, not a code one.**
- [ ] A second region means a second data plane plus routing (`RegionRegistryService.planeFor`). It is never just a label change.

## Vercel (restiq-web)
- [ ] `NEXT_PUBLIC_API_URL` = the Fly app's https URL.
- [ ] `PROXY_SHARED_SECRET` (server-only, not `NEXT_PUBLIC_`) has the same value as Fly's.
- [ ] `POS_TENANT_ID` is unset in production, because terminals come from device enrolment links.

## DNS / TLS
- [ ] Custom domains resolve, the certificates are valid, and HSTS is on (Vercel default; Fly `force_https = true`).

## Secret rotation
- **Rotating a JWT secret signs everyone in that realm out.** Rotate one realm at a time, outside trading hours.
- **Rotating `PROXY_SHARED_SECRET`:** set the new value in Vercel and Fly together.
  - Between the two changes, sign-in throttling falls back to the web server's address.
  - Per-account and per-device limits keep working.
