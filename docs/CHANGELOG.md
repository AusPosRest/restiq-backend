# Changelog

## Unreleased

### Fixed

- #242 (AP-cu-1): till Lock/logout revokes only the presented POS token, keeping the same staff member’s kitchen and other device sessions active. Logged-out tokens cannot be replayed. Legacy tokens retain all-session logout; PIN and role changes still end every session.
