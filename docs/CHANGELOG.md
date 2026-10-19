# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Allow line edits after failed card attempts or with outstanding unpaid shares (#234 follow-up); retain protection for all tenders, active intents and paid shares.
- Refuse line removal, quantity or modifier price reductions, and manager voids after payment starts on an open bill (#234). Return `409 bill_has_payments`; additions and quantity increases remain allowed. Serialize the check and payment-intent creation on the bill row.
