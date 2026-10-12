# Changelog

## Unreleased

### Fixed

- Cashier refunds can use an active staff PIN whose role has `refunds` and whose outlet assignments include the bill's outlet (empty assignments mean all outlets). Missing cashier approval remains 403 `forbidden`; an incorrect PIN remains 401 `invalid_credentials`. Managers still need a PIN. Credit notes and audit events retain the approving staff ID. No migration. (#240, AP-pe-2)
