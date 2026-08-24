// CAP-6 severity classification (SPEC success criteria): silent past 48h,
// lagging past 1h, healthy otherwise. Pure and unit-tested so the boundaries
// are pinned down precisely.
export type Severity = 'healthy' | 'lagging' | 'silent'

export const LAGGING_THRESHOLD_SECONDS = 60 * 60
export const SILENT_THRESHOLD_SECONDS = 48 * 60 * 60

export function classifySeverity(lagSeconds: number): Severity {
  if (lagSeconds > SILENT_THRESHOLD_SECONDS) return 'silent'
  if (lagSeconds > LAGGING_THRESHOLD_SECONDS) return 'lagging'
  return 'healthy'
}

const SEVERITY_RANK: Record<Severity, number> = { silent: 0, lagging: 1, healthy: 2 }

/** Silent > lagging > healthy (EXPERIENCE.md O8 default sort). */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b]
}
