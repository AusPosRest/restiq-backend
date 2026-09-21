# Operations runbooks

Prepared for the production-readiness audit (issue #175, `docs/PRODUCTION-READINESS-AUDIT-2026-09-21.md` in the Restiq workspace). Each runbook names what needs **live access**: Fly, Neon, Vercel, DNS, the alert destination, or real hardware. None of it has been run against production yet.

| Runbook | Audit item | Needs |
|---|---|---|
| [launch-configuration.md](launch-configuration.md) | PROD-11 | Fly + Vercel secrets, Neon console |
| [release.md](release.md) | PROD-06 | GitHub, Fly, Vercel |
| [backup-restore.md](backup-restore.md) | PROD-08 | Neon console, a scratch database |
| [alerts.md](alerts.md) | PROD-09 | an alert destination (Slack/Teams/pager), uptime checker |
| [staging-rehearsal.md](staging-rehearsal.md) | PROD-10 | a staging Fly app + Neon branch + Vercel preview, test hardware |
