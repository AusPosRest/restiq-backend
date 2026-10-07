// restiq-backend#175 (audit PROD-11): in production a missing or unsafe
// setting stops the boot with every problem listed, before any traffic -
// rather than a wrong region label, a guessable token secret or the payment
// simulator surfacing later in front of a venue. Only checks what is wrong
// on its face; whether HOME_REGION matches the tenants' data is the launch
// checklist's job (wiki/ops/launch-configuration.md).
const JWT_SECRETS = ['OPS_JWT_SECRET', 'ADMIN_JWT_SECRET', 'POS_JWT_SECRET', 'GUEST_JWT_SECRET'] as const
const MIN_SECRET_LENGTH = 32

export function productionConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = []

  if (!env.HOME_REGION) problems.push('HOME_REGION must be set explicitly (the region existing tenants are registered in)')

  const secrets = JWT_SECRETS.map((name) => [name, env[name] ?? ''] as const)
  for (const [name, value] of secrets) {
    if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`)
  }
  const values = secrets.map(([, value]) => value).filter(Boolean)
  if (new Set(values).size !== values.length) problems.push('The JWT secrets must all be different - a shared secret merges two sign-in realms')

  if (!env.PROXY_SHARED_SECRET || env.PROXY_SHARED_SECRET.length < MIN_SECRET_LENGTH) {
    problems.push(`PROXY_SHARED_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters, same value as the web app) so sign-in throttling sees real client addresses`)
  }
  if (env.PAYMENTS_SIMULATOR === 'on') problems.push('PAYMENTS_SIMULATOR must not be on in production - it approves card payments with no money moving')
  if (!env.WEB_ORIGIN?.startsWith('https://')) problems.push('WEB_ORIGIN must be the https:// origin of the web app')

  return problems
}

/** Throws with every problem at once when running in production. */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  const problems = productionConfigProblems(env)
  if (problems.length > 0) {
    throw new Error(`Refusing to start - production configuration problems:\n- ${problems.join('\n- ')}`)
  }
}
