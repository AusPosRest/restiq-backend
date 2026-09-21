// restiq-backend#170: the simulated card terminal approves payments without
// any money moving, so it is off unless PAYMENTS_SIMULATOR=on (local dev,
// demos, e2e). Read on every call rather than at boot so one process can't
// cache a stale answer. Checked in the services - intent creation, the
// simulate webhook, confirmIntent and bill finalisation - not only at a route.
export function paymentsSimulatorEnabled(): boolean {
  return process.env.PAYMENTS_SIMULATOR === 'on'
}
