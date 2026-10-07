// Public surface of the pos module - cross-module imports go through here.
export { PosModule } from './pos.module'
// The one intent -> tender path (issue #130); a real provider's webhook will call it too.
export { confirmIntent } from './payments/intent-core'
