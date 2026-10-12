# Changelog

## Unreleased

### Fixed

- Refuse line removal, quantity or modifier price reductions, and manager voids after payment starts on an open bill (#234). Return `409 bill_has_payments`; additions and quantity increases remain allowed. Serialize the check and payment-intent creation on the bill row.
