# Changelog

## Unreleased

### Fixed

- Allow line edits after failed card attempts or with outstanding unpaid shares (#234 follow-up); retain protection for all tenders, active intents and paid shares.
- Refuse line removal, quantity or modifier price reductions, and manager voids after payment starts on an open bill (#234). Return `409 bill_has_payments`; additions and quantity increases remain allowed. Serialize the check and payment-intent creation on the bill row.
