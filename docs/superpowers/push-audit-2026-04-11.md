# Push infrastructure audit — 2026-04-11

## 1. Subscribe endpoint (`src/pages/api/push/subscribe.ts`)

- Accepts `{ sessionId, subscription: { endpoint, expirationTime, keys: { p256dh, auth } } }`
- Runs `UPDATE monitoring_sessions SET push_subscription = ? WHERE id = ?`
- Returns `{ success: true }` on success
- **Issue:** Only does UPDATE, not INSERT. If no row exists for the sessionId, the update silently succeeds with 0 rows changed. The row is inserted earlier by `/api/checkout/create` with `push_subscription = ''`.
- **Issue (BLOCKER):** The endpoint is returning HTTP 404 on production — `src/pages/api/push/subscribe.ts` was never committed to git and never deployed. The dist has it built but deployment was not executed after the file was added.

## 2. Stripe webhook → session activation (`src/pages/api/webhooks/stripe.ts:30-48`)

- On `checkout.session.completed`: updates `monitoring_sessions SET payment_status='completed', status='active'` WHERE `stripe_session_id = ?`
- Correctly transitions status to `active` so `checkMonitoringSessions` picks it up
- Uses `session.metadata.sessionId` (set in `/api/checkout/create`) to find the row

## 3. Push-send code path (`workers/cron/src/index.ts`)

- Function: `sendPushNotification(subscriptionJson: string, payload: PushPayload, env?)` at line 1309
- No npm dependency — uses Web Crypto API + manual VAPID JWT signing
- Called from `processSession()` (lines 1267, 1279) — cron path
- Called from `/__trigger/test-push` (added 2026-04-11) — test endpoint
- **Fixed 2026-04-11:** `env` was not passed at call sites (lines 1267, 1279), so VAPID headers were never sent. Fixed.
- Push sends empty body (`Content-Length: 0`). Service worker wakes and fetches details from API.

## 4. D1 schema — `monitoring_sessions`

Key fields: `id TEXT PK`, `push_subscription TEXT NOT NULL` (initially `''`, updated post-payment), `status TEXT DEFAULT 'active'`, `stripe_session_id TEXT`, `payment_status TEXT DEFAULT 'pending'`
Full required-at-insert fields: `train_a_schedule_id`, `train_a_order_id`, `transfer_station_id`, `train_b_schedule_id`, `train_b_order_id`, `operating_date` — all inserted as `0`/`''` placeholders by checkout; real values not used by current push logic.

## 5. VAPID secrets

- `VAPID_PRIVATE_KEY`: present as Worker secret on cron worker (confirmed via `wrangler secret list`)
- `VAPID_PUBLIC_KEY`: was only a `var` on the main site worker (`wrangler.jsonc`), **missing** from cron worker. Fixed 2026-04-11 — added to `workers/cron/wrangler.jsonc` vars.
- Cron worker `Env` interface also lacked both VAPID fields. Fixed 2026-04-11.

## Summary

| Layer | Status | Note |
|---|---|---|
| Subscribe endpoint (code) | PASS | Code correct |
| Subscribe endpoint (deployed) | BROKEN | Not committed/deployed — returns 404 live |
| Stripe webhook → active | PASS | Correct at lines 30-48 |
| Push-send helper | PASS (after fix) | env not passed before; now fixed |
| VAPID_PRIVATE_KEY secret | PASS | Present on cron worker |
| VAPID_PUBLIC_KEY var | FIXED | Was missing from cron worker; added |
| `/__trigger/test-push` | PASS | Added + deployed 2026-04-11 |
