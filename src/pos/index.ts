// Public surface of the pos module - cross-module imports go through here.
export { PosModule } from './pos.module'
// The offline sync read side; e2e drives its daily sync_changes prune directly (#292).
export { SyncService } from './sync/sync.service'
// The one intent -> tender path (issue #130); a real provider's webhook will call it too.
export { confirmIntent } from './payments/intent-core'
// An outlet's own calendar day (issue #189: the owner dashboard's "today").
export { localDateKey } from './clock/clock.util'
// Offline sync op payloads (#297): the hub's op recorder validates what it records against these.
export * from './sync/sync.dtos'
