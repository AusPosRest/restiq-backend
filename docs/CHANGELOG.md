# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Silent-device alerts run every minute without opening sync health, with one alert per silent period per API process. Recovery or a newer heartbeat permits another alert; timers stop on shutdown and are disabled in tests (#233).
- Production startup requires `ALERT_WEBHOOK_URL`; development and test environments may omit it (#233).
- #242 (AP-cu-1): till Lock/logout revokes only the presented POS token, keeping the same staff member’s kitchen and other device sessions active. Logged-out tokens cannot be replayed. Legacy tokens retain all-session logout; PIN and role changes still end every session.
- QR guests can add and edit special instructions (trimmed, up to 200 characters). Cart notes reach order lines and the kitchen; separate adds remain separate lines (#231).
- Cashier refunds can use an active staff PIN whose role has `refunds` and whose outlet assignments include the bill's outlet (empty assignments mean all outlets). Missing cashier approval remains 403 `forbidden`; an incorrect PIN remains 401 `invalid_credentials`. Managers still need a PIN. Credit notes and audit events retain the approving staff ID. No migration. (#240, AP-pe-2)
- Allow line edits after failed card attempts or with outstanding unpaid shares (#234 follow-up); retain protection for all tenders, active intents and paid shares.
- Refuse line removal, quantity or modifier price reductions, and manager voids after payment starts on an open bill (#234). Return `409 bill_has_payments`; additions and quantity increases remain allowed. Serialize the check and payment-intent creation on the bill row.
