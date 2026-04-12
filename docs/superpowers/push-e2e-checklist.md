# niejedzie push notification — end-to-end client-side test

**When to run:** after the server-side verification in `push-audit-2026-04-11.md` passes. Takes ~5 min.

**You need:** a phone with Chrome (Android) or Safari (iOS) + your own Stripe-compatible card.

## Steps

1. **iOS only:** Safari → `https://niejedzie.pl` → share → "Add to Home Screen". Open the home-screen icon. iOS requires the site as a PWA before web push works. Android Chrome: skip to step 2.

2. **Homepage:** enter a known train number (e.g. `IC 5313`) and destination (e.g. `Warszawa Centralna`). Tap **Sprawdź połączenie**.

3. **On `/wynik`:** tap the orange **Monitoruj przesiadkę — 5 zł** button. Stripe Checkout opens.

4. **In Stripe Checkout:** pay with your own card. This is a real 5 zł charge in live mode — you can refund it after from the Stripe dashboard → Payments → Refund.

5. **On `/sukces`** after successful payment: you'll be prompted to grant notification permission. Tap **Allow**. Note the session ID shown on the page (or check the URL).

6. **From any device** (laptop fine), visit the test endpoint with your session ID:
   ```
   https://niejedzie-cron.maciej-janowski1.workers.dev/__trigger/test-push?session=<your-session-id>
   ```
   Response should be `{"sent": true, ...}`.

7. **On your phone:** a push titled **niejedzie.pl — test push** should arrive within ~10 seconds.

## What to report back

- **Step 7 works** → e2e validated. Reply: `PASS` + the session ID.
- **No push arrives** → report the exact step where things broke:
  - No Stripe checkout opens? — /wynik CTA wiring issue
  - No notification prompt? — service worker registration bug
  - `{"sent": true}` response but no phone notification? — VAPID signing / subscription endpoint issue
  - Error on the test endpoint? — paste the JSON response

## Refund your test payment

Stripe dashboard → Payments → find the 5 zł test charge → Refund.
