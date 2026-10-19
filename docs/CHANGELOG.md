# Changelog

## Unreleased

### Fixed

- Guest QR bill payment now sends any unsent staff-added lines to the kitchen through the shared finalize transaction. POS finalize uses the same hook once; already-ticketed lines are skipped, and rejected settlement creates no tickets (#228).
