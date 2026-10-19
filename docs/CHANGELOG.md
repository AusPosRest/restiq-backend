# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- KDS Serve (expo) keeps a paid order on screen as Ready after its last ticket is bumped, for the Done tab's 12-hour window, so the runner can call the token. Refunded and discarded orders do not appear (#243, AP-cu-5).
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Silent-device alerts run every minute without opening sync health, with one alert per silent period per API process. Recovery or a newer heartbeat permits another alert; timers stop on shutdown and are disabled in tests (#233).
- Production startup requires `ALERT_WEBHOOK_URL`; development and test environments may omit it (#233).
