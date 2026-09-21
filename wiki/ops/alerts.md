# Alerts and on-call (PROD-09)

## What exists in code
- **Silent device.** The sync-health sweep finds devices that haven't reported for the silent threshold.
  - `WebhookAlertChannel` posts the alert (JSON `{ text, alert }`) to `ALERT_WEBHOOK_URL` and logs it.
  - With no URL it only logs.

## Still to set up (needs access)
- [ ] **Destination:** a Slack or Teams incoming webhook for the on-call channel, or a pager's generic webhook. Store it as `fly secrets set ALERT_WEBHOOK_URL=…`.
- [ ] **Uptime checks** from outside Fly (for example Better Stack or UptimeRobot) on:
  - `https://<api>/health` every minute, where a page means down for 3 minutes;
  - `/health/db`, where a warning means down for 5 minutes;
  - the web origin.
- [ ] **Error tracking:** Sentry (or similar) DSN in the API and the web. Needs an account.
- [ ] **Payment exceptions:** once a real provider lands (epic #129), alert on intents stuck `pending` past their TTL and on webhook signature failures.
- [ ] **Named responder and escalation:** who is on call during trading hours, and who comes next.

## Responding to a silent-device alert
1. Open the Platform Console → Devices, find the device, and check its outlet and last contact.
2. Call the outlet and check the tablet is on, the network is up, and the app is open.
3. If the outlet is trading offline, nothing is lost yet, because the POS is online-only today. Tell them to take orders on paper and card on their own terminal until it's back.
4. Close the alert with the cause in the channel thread.

## Drill (before launch)
Stop a staging device heartbeat, stop the staging API, and fail a payment reconciliation case. Each must reach the responder with enough context to act on.
