// Offline sync (restiq-backend#185, docs/SYNC-DESIGN.md §5): a hub till pushes
// a sale it has already made. These optional fields carry what the till
// decided, so the cloud records the same sale (same ids, same time, same
// price the guest paid) instead of re-deciding it. Online callers never pass
// them, so their behaviour is unchanged.
export interface Replay {
  /** Id the till gave the row; kept so a re-sent op finds it again. */
  id: string
  /** When it happened on the till (business time for reports). */
  at: Date
}
