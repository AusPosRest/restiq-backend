// A tenant's subdomain name (D14). Pure helpers, no database.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/

// Names our own surfaces use or a visitor could mistake for them. Never given to a tenant.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'admin', 'ops', 'pos', 'kds', 'qr', 'guest', 'device', 'devices', 'hub', 'public', 'login', 'auth',
  'mail', 'email', 'smtp', 'support', 'help', 'docs', 'status', 'billing', 'staging', 'stage', 'dev', 'test', 'demo',
  'static', 'assets', 'cdn', 'restiq', 'idelta', 'root', 'system', 'internal', 'sandbox', 'portal',
])

export type SlugProblem = 'invalid' | 'reserved'

export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) return 'invalid'
  return RESERVED_SLUGS.has(slug) ? 'reserved' : null
}

/** A starting suggestion from a company name: "Bay Leaf Kitchens Pvt Ltd" -> "bay-leaf-kitchens". */
export function slugify(name: string): string {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/(-(pvt|ltd|llp|inc|pty|limited|private))+$/g, '')
  const trimmed = words.slice(0, 31).replace(/-+$/g, '')
  return trimmed.length >= 3 ? trimmed : `${trimmed}-restaurant`.replace(/^-/, '').slice(0, 31)
}

/** "bayleaf.idelta.com.au" under base "idelta.com.au" -> "bayleaf"; anything else (the bare base, another host, deeper names) -> null. */
export function slugFromHost(host: string, baseDomain: string): string | null {
  const bare = host.trim().toLowerCase().replace(/:\d+$/, '')
  const base = baseDomain.trim().toLowerCase()
  if (!bare.endsWith(`.${base}`)) return null
  const slug = bare.slice(0, -(base.length + 1))
  return slug.includes('.') || slugProblem(slug) === 'invalid' ? null : slug
}
