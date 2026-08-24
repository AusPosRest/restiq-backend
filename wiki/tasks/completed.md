# Completed

- **2026-08-24** - Tenant Admin story 1: owner invite acceptance (CAP-1) and
  go-live checklist API (CAP-2). `POST /admin/v1/auth/accept-invite`,
  `GET /admin/v1/checklist`, `PATCH /admin/v1/checklist/:step`,
  `POST /admin/v1/checklist/go-live`. New `/admin` auth realm (AD-10,
  `aud:"admin"`), `owner_users` and `checklist_progress` tables. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#26.
- **2026-08-24** - Tenant Admin story 2: AI-assisted menu import (CAP-3).
  `POST /admin/v1/menu-import/upload` (real CSV/XLSX parsing, stubbed
  image/PDF), `PATCH /admin/v1/menu-import/:importId` (review/edit),
  `POST /admin/v1/menu-import/:importId/commit` (atomic catalogue write +
  checklist flip). New `item_prices` table (AD-11, insert-only price
  history - binds every writer, including the story-1 sample-menu seed,
  which was updated to match) and `menu_import_drafts` table; `menu_items`
  gained `short_name` (PRD FR-10) and lost its price columns. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#28.
