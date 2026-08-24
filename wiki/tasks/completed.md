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
- **2026-08-24** - Tenant Admin story 3: menu management with versioned
  pricing (CAP-4). Full CRUD under `/admin/v1/menu` for categories, items
  (with variants, modifier groups, allergen tags nested), modifier groups,
  allergens, and combos; `item_prices` (story 2) extended with
  `variantId`/`outletId`/`channel`/`effectiveAt` dimensions and a
  well-tested current-price resolution query (`menu/pricing.ts`); the 86
  availability toggle and a per-outlet availability override; new tables
  `item_variants`, `modifier_groups`, `modifiers`, `item_modifier_groups`,
  `allergens`, `item_allergens`, `combos`, `combo_components`,
  `item_outlet_overrides`. Price edits are audited (`menu.item.price_changed`,
  reason required) per the SPEC's security-relevant list; routine content
  CRUD is not. See [wiki/features/tenant-admin.md](../features/tenant-admin.md).
  Issue AusPosRest/restiq-backend#30.
