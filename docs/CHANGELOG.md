# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **pnpm pinned to 10.34.4** (#276): `packageManager` in package.json, so the Docker image's corepack stops pulling the newest pnpm, which ignored the build-script allow-list and failed the Fly build.
- **Production can boot before Mailjet and an alert webhook exist** (#274): `MAIL_PROVIDER=simulator` is accepted (reset and invite mail goes to the ops dev inbox), and `ALERT_WEBHOOK_URL=off` means log-only alerts. `log` mail and an unset webhook still refuse to boot.
- **Two trusted proxy hops** (#272): `fly.toml` sets `TRUST_PROXY_HOPS=2`, because `api.dailypos.shop` now goes through Cloudflare and then Fly. `req.ip` stays the real client instead of a shared Cloudflare address.

### Added
- Per-tenant India CGST/SGST rounding (#244): `gstSplitRounding` (`exact_total` default, `equal_half_up`, `equal_half_even`) on `GET`/`PUT /admin/v1/tax-registration`, stored in `tenant_tax_registrations.gst_split_rounding` (migration `20261019100000_gst_split_rounding`). POS and guest bill responses add `gstSplitRounding` (null for AU, IGST and composition). Finalized bills keep their stored tax lines.

### Fixed
- Cash round-off is stored (#241, Q28): finalize also accepts tenders where the cash share is rounded per market rule (IN nearest Rs 1, AU nearest 5c; only the cash part of a split) and stores the adjustment as `bills.round_off_minor`. Cash tenders may carry `tenderedMinor` (cash handed over; change derived). Shift expected cash, the outlet payments list and the owner payments report now count what went into the drawer, so shift close no longer shows a false over/short. Bill, invoice and payments-report views expose `roundOffMinor`; tenders expose `tenderedMinor`/`changeMinor`; the payments CSV gains a trailing `round_off` column. Exact-total tenders still finalize as before.
- KDS Serve (expo) keeps a paid order on screen as Ready after its last ticket is bumped, for the Done tab's 12-hour window, so the runner can call the token. Refunded and discarded orders do not appear (#243, AP-cu-5).
- India CGST/SGST no longer over-collects a paisa: total GST is rounded once, then split CGST = lower half, SGST = remainder (Rs 289 at 5% is 14.45 = 7.22 + 7.23, was 14.46). Applies to bills, bill preview, invoices, refunds and reports, which all read the same tax result; IGST and AU GST unchanged (#244, AP-cu-15).
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Silent-device alerts run every minute without opening sync health, with one alert per silent period per API process. Recovery or a newer heartbeat permits another alert; timers stop on shutdown and are disabled in tests (#233).
- Production startup requires `ALERT_WEBHOOK_URL`; development and test environments may omit it (#233).
- #242 (AP-cu-1): till Lock/logout revokes only the presented POS token, keeping the same staff member’s kitchen and other device sessions active. Logged-out tokens cannot be replayed. Legacy tokens retain all-session logout; PIN and role changes still end every session.
- QR guests can add and edit special instructions (trimmed, up to 200 characters). Cart notes reach order lines and the kitchen; separate adds remain separate lines (#231).
- Cashier refunds can use an active staff PIN whose role has `refunds` and whose outlet assignments include the bill's outlet (empty assignments mean all outlets). Missing cashier approval remains 403 `forbidden`; an incorrect PIN remains 401 `invalid_credentials`. Managers still need a PIN. Credit notes and audit events retain the approving staff ID. No migration. (#240, AP-pe-2)
- Allow line edits after failed card attempts or with outstanding unpaid shares (#234 follow-up); retain protection for all tenders, active intents and paid shares.
- Refuse line removal, quantity or modifier price reductions, and manager voids after payment starts on an open bill (#234). Return `409 bill_has_payments`; additions and quantity increases remain allowed. Serialize the check and payment-intent creation on the bill row.
- Guest QR bill payment now sends any unsent staff-added lines to the kitchen through the shared finalize transaction. POS finalize uses the same hook once; already-ticketed lines are skipped, and rejected settlement creates no tickets (#228).
- An order left open for over 12 hours (the KDS live window, now one shared constant) no longer marks its table occupied on the POS table map or blocks a QR session there (#230). Nothing is auto-closed (Q26).
- Placing an order on a table whose open order is over 12 hours old (QR place-order or POS open table) moves that leftover order off the table (table cleared, status and lines unchanged, audited `order.detached_stale_table`) and places the new one. The leftover order stays in POS Open orders for End of day (#251). A table whose open order is under 12 hours old still answers 409 (#230).
