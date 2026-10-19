# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Silent-device alerts run every minute without opening sync health, with one alert per silent period per API process. Recovery or a newer heartbeat permits another alert; timers stop on shutdown and are disabled in tests (#233).
- Production startup requires `ALERT_WEBHOOK_URL`; development and test environments may omit it (#233).
- An order left open for over 12 hours (the KDS live window, now one shared constant) no longer marks its table occupied on the POS table map or blocks a QR session there (#230). Nothing is auto-closed (Q26).
- Placing an order on a table whose open order is over 12 hours old (QR place-order or POS open table) moves that leftover order off the table (table cleared, status and lines unchanged, audited `order.detached_stale_table`) and places the new one. The leftover order stays in POS Open orders for End of day (#251). A table whose open order is under 12 hours old still answers 409 (#230).
