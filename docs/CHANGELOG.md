# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Cash round-off is stored (#241, Q28): finalize also accepts tenders where the cash share is rounded per market rule (IN nearest Rs 1, AU nearest 5c; only the cash part of a split) and stores the adjustment as `bills.round_off_minor`. Cash tenders may carry `tenderedMinor` (cash handed over; change derived). Shift expected cash, the outlet payments list and the owner payments report now count what went into the drawer, so shift close no longer shows a false over/short. Bill, invoice and payments-report views expose `roundOffMinor`; tenders expose `tenderedMinor`/`changeMinor`; the payments CSV gains a trailing `round_off` column. Exact-total tenders still finalize as before.
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Silent-device alerts run every minute without opening sync health, with one alert per silent period per API process. Recovery or a newer heartbeat permits another alert; timers stop on shutdown and are disabled in tests (#233).
- Production startup requires `ALERT_WEBHOOK_URL`; development and test environments may omit it (#233).
