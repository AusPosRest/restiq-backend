// Checks the Stripe keys in .env without printing them or moving money.
// Run: pnpm stripe:check
// ponytail: plain fetch against the REST API; swap for the stripe SDK when the real integration lands.
try {
  process.loadEnvFile('.env');
} catch {
  console.error('No .env file found in restiq-backend.');
  process.exit(1);
}

const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
const publishable = process.env.STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
const mask = (k: string): string => (k ? `${k.slice(0, 8)}…` : '(empty)');
let failed = false;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

async function stripe(key: string, path: string, body?: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}` },
    body: body ? new URLSearchParams(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

const errorOf = (r: Record<string, unknown>): string | undefined =>
  (r.error as { message?: string } | undefined)?.message;

async function main(): Promise<void> {
  console.log(`STRIPE_SECRET_KEY      = ${mask(secret)}`);
  console.log(`STRIPE_PUBLISHABLE_KEY = ${mask(publishable)}\n`);

  report('secret key present', /^(sk|rk)_test_/.test(secret), secret ? 'expected sk_test_/rk_test_' : 'empty');
  report('publishable key present', /^pk_test_/.test(publishable), publishable ? 'expected pk_test_' : 'empty');
  if (!secret) return;
  if (/_live_/.test(secret)) {
    report('safety', false, 'live key detected - refusing to call Stripe. Use Test mode keys (sk_test_/pk_test_).');
    return;
  }

  const balance = await stripe(secret, 'balance');
  const balErr = errorOf(balance);
  report('secret key accepted (balance)', !balErr && balance.livemode === false,
    balErr ?? `livemode=${String(balance.livemode)}`);

  // Unconfirmed PaymentIntent: proves payment permission, no money moves. Cancelled right after.
  const pi = await stripe(secret, 'payment_intents', {
    amount: '100',
    currency: 'aud',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[purpose]': 'restiq-key-check',
  });
  const piErr = errorOf(pi);
  report('can create PaymentIntent', !piErr, piErr ?? `${String(pi.id)} status=${String(pi.status)}`);
  if (!piErr) await stripe(secret, `payment_intents/${String(pi.id)}/cancel`, {});

  if (publishable) {
    const tok = await stripe(publishable, 'tokens', { 'pii[id_number]': '000000000' });
    const tokErr = errorOf(tok);
    report('publishable key accepted', !tokErr && tok.livemode === false, tokErr ?? `livemode=${String(tok.livemode)}`);
  }
}

main()
  .catch((e: unknown) => {
    failed = true;
    console.error('Network/unexpected error:', e instanceof Error ? e.message : e);
  })
  .finally(() => {
    console.log(failed ? '\nStripe check FAILED' : '\nStripe check passed');
    process.exitCode = failed ? 1 : 0;
  });
