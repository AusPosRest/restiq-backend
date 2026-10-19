# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- India CGST/SGST no longer over-collects a paisa: total GST is rounded once, then split CGST = lower half, SGST = remainder (Rs 289 at 5% is 14.45 = 7.22 + 7.23, was 14.46). Applies to bills, bill preview, invoices, refunds and reports, which all read the same tax result; IGST and AU GST unchanged (#244, AP-cu-15).
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Silent-device alerts run every minute without opening sync health, with one alert per silent period per API process. Recovery or a newer heartbeat permits another alert; timers stop on shutdown and are disabled in tests (#233).
- Production startup requires `ALERT_WEBHOOK_URL`; development and test environments may omit it (#233).
- #242 (AP-cu-1): till Lock/logout revokes only the presented POS token, keeping the same staff member’s kitchen and other device sessions active. Logged-out tokens cannot be replayed. Legacy tokens retain all-session logout; PIN and role changes still end every session.
