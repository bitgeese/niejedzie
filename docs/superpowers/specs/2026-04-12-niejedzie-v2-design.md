# niejedzie.pl v2 — Pure SaaS Rebuild

**Date:** 2026-04-12
**Status:** Design approved, ready for implementation plan
**Context:** v1 torn down after $550 Cloudflare D1 overage (per-write billing × 55K rows/poll × 288 polls/day). Product signal was real (42 visitors/30d, 4m41s sessions, Facebook railway community traffic, zero competitors in the transfer-monitoring niche). v2 rebuilds the same product on infrastructure with zero per-operation billing.

---

## 1. Product

**One-liner:** "Masz przesiadkę? Sprawdzimy czy zdążysz."

Train transfer monitor for Polish railways. User enters a train number and destination, the system checks whether the connection is direct or requires a transfer, and offers paid real-time monitoring with push alerts if a delay threatens the transfer.

**Unique angle (still uncontested as of April 2026):** No Polish app offers paid push alerts specifically for transfer-connection integrity. Portal Pasażera, KOLEO, PKP IC Mobile Navigator, PolishTrains — all do basic delay checking but none monitor "will I make my transfer?" with proactive alerts.

**Target user:** Polish train commuter who makes 2-5 transfer connections per month and values not missing them (worth 5-15 zł/month to avoid the stress).

---

## 2. Architecture

### Infrastructure

| Component | Choice | Cost | Why |
|---|---|---|---|
| Server | Hetzner Cloud CX22 (2 vCPU, 4GB RAM, 40GB SSD) | €4.51/mo | Fixed price, zero per-op billing, Falkenstein DC closest to Poland |
| Framework | Next.js on Node.js | $0 | SSR for SEO, ready for future auth/dashboard |
| Database | SQLite via `better-sqlite3` | $0 | Embedded, microsecond reads, zero network hops, backup = copy file |
| Cron | Linux crontab | $0 | Native, no limits, no billing |
| DNS/CDN | Cloudflare free tier | $0 | Proxy + cache, DDoS protection, SSL |
| Payments | Stripe (existing live account) | 1.4% + 0.25€ per txn | Same products: 5 zł one-time + 15 zł/mo |
| Push | Web Push API + VAPID | $0 | No third-party push service needed |
| Analytics | Plausible (existing) | $0 (included in existing plan) | data-domain: niejedzie.pl |
| Provisioning | Hetzner Cloud API + `hcloud` CLI | $0 | Full API — server, SSH keys, firewall all via CLI |

**Total monthly cost: ~$5/month.** No variable billing component.

### Data flow

```
┌──────────────────────────────────────────────────────────────┐
│ Hetzner VPS (CX22, Falkenstein)                              │
│                                                              │
│  ┌─────────────┐    ┌───────────────┐    ┌───────────────┐  │
│  │ Linux cron   │───>│ poll.ts       │───>│ SQLite        │  │
│  │ every 5 min  │    │ (PKP API →    │    │ niejedzie.db  │  │
│  │              │    │  parse →      │    │               │  │
│  │              │    │  upsert)      │    │ Tables:       │  │
│  │              │    └───────────────┘    │ - stats       │  │
│  │              │                         │ - trains      │  │
│  │              │    ┌───────────────┐    │ - sessions    │  │
│  │              │───>│ check-push.ts │───>│ - stations    │  │
│  │ every 1 min  │    │ (delay >      │    └───────┬───────┘  │
│  │              │    │  threshold →  │            │          │
│  │              │    │  web-push)    │            │          │
│  └──────────────┘    └───────────────┘            │          │
│                                                    │          │
│  ┌─────────────────────────────────────────────────┘         │
│  │                                                            │
│  ▼                                                            │
│  ┌───────────────┐                                           │
│  │ Next.js SSR   │◄──── User HTTP request                    │
│  │ (reads SQLite │                                           │
│  │  at request   │────> Rendered HTML                        │
│  │  time)        │                                           │
│  └───────────────┘                                           │
│                                                              │
│  ┌───────────────┐                                           │
│  │ Stripe webhook│◄──── Stripe checkout.session.completed    │
│  │ handler       │────> INSERT monitoring_sessions           │
│  └───────────────┘                                           │
└──────────────────────────────────────────────────────────────┘
         ▲
         │ HTTPS (Cloudflare proxy)
         │
    niejedzie.pl
```

### Key design principle: no managed-service billing traps

Every component runs on the fixed-price VPS. SQLite writes are free (local disk I/O). Cron is free (OS-level). Push is free (direct HTTPS to browser push endpoints). The only variable cost is Stripe's per-transaction fee, which is revenue-positive by definition.

---

## 3. Data layer

### SQLite schema (4 tables)

```sql
-- Aggregated stats, refreshed every 5 min by cron
CREATE TABLE stats (
  key TEXT PRIMARY KEY,        -- 'today', 'yesterday', etc.
  data JSON NOT NULL,          -- {totalTrains, punctuality, avgDelay, cancelled, topDelayed[], hourlyDelays[]}
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Active trains from PKP API, refreshed every 5 min
CREATE TABLE active_trains (
  operating_date TEXT NOT NULL,
  train_number TEXT NOT NULL,
  carrier TEXT,
  route_start TEXT,
  route_end TEXT,
  is_delayed INTEGER DEFAULT 0,
  max_delay INTEGER DEFAULT 0,
  schedule_id INTEGER,
  order_id INTEGER,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (operating_date, train_number)
);

-- Train routes for connection checking (refreshed daily at 02:00)
CREATE TABLE train_routes (
  operating_date TEXT NOT NULL,
  train_number TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  station_name TEXT,
  station_id INTEGER,
  arrival_time TEXT,
  departure_time TEXT,
  PRIMARY KEY (operating_date, train_number, stop_sequence)
);

-- Paid monitoring sessions
CREATE TABLE monitoring_sessions (
  id TEXT PRIMARY KEY,
  train_number TEXT NOT NULL,
  destination TEXT NOT NULL,
  push_subscription TEXT,           -- JSON PushSubscription object
  stripe_session_id TEXT,
  payment_status TEXT DEFAULT 'pending',  -- pending | paid | refunded
  payment_type TEXT,                -- onetime | subscription
  status TEXT DEFAULT 'pending',    -- pending | active | expired | completed
  operating_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT                   -- for one-time: end of operating day
);
```

### What's NOT stored

- No `delay_snapshots` table. The v1 table that stored per-station delay data for every train every 5 min was the $550 mistake. v2 stores only aggregated stats (1 JSON blob) and active train status (1 row per train, upserted).
- No `daily_stats` / `city_daily` — no historical aggregation in MVP. Add later if needed.
- No `disruptions` table — disruptions are part of the stats JSON blob.
- No `stations` table — station names come from train_routes, resolved at request time.

### Write volume estimate

| Table | Rows per poll | Polls/day | Writes/day |
|---|---|---|---|
| stats | 1 upsert | 288 | 288 |
| active_trains | ~5,500 upserts | 288 | ~1.58M |
| train_routes | ~55,000 upserts | 1 (daily) | ~55,000 |
| monitoring_sessions | ~0-2 inserts | on-demand | ~0-10 |

Total: ~1.64M writes/day. On local SQLite this costs $0. On D1 this would cost $1.64/day = $49/month. The architecture choice matters.

---

## 4. PKP API integration

### Data source

Single source: **PKP PLK Open Data API** at `pdp-api.plk-sa.pl`.

- API key: stored in `.env` on the VPS (user has it saved separately)
- Tier: Standard (500 req/hr, 5,000 req/day)

### Cron jobs

| Schedule | Script | What |
|---|---|---|
| `*/5 * * * *` | `scripts/poll-operations.ts` | Fetch `/api/v1/operations` + `/api/v1/operations/statistics`, compute stats JSON, upsert active_trains |
| `*/1 * * * *` | `scripts/check-push.ts` | For each active monitoring_session: check if monitored train's delay exceeds threshold → fire web-push |
| `0 2 * * *` | `scripts/sync-routes.ts` | Fetch `/api/v1/schedules` for today + yesterday → upsert train_routes |
| `0 3 * * *` | `scripts/prune.ts` | DELETE active_trains/train_routes older than 3 days |

### Field quirks (carry forward from v1)

- `scheduleId` = annual timetable year (2026), NOT a train ID
- Real train number: `nationalNumber → internationalDepartureNumber → internationalArrivalNumber → name → compound placeholder`
- Carrier codes: short form (`IC`, `KM`, `PR`, `KD`, etc.)
- `/schedules` endpoint is non-paginated (returns all ~5,535 routes in one response)
- API intermittently returns 530/1016 — 3-attempt retry with linear backoff (500ms, 1000ms)

---

## 5. Pages

### 1. `/` — Homepage

Hero with train station photo, headline "Masz przesiadkę? Sprawdzimy czy zdążysz.", two-field form (train number + destination), submit → `/wynik`. Below: how-it-works steps, pricing preview, live delayed train example (from stats JSON).

Reuse v1 visual design: cream bg (`#fffbf5`), burnt sienna accent (`#c2410c`), Outfit + JetBrains Mono fonts.

### 2. `/wynik` — Connection check result

SSR page. Reads `?train=X&destination=Y` query params. Queries SQLite:
1. Find train in `active_trains` by number (substring match)
2. Find destination in `train_routes` by station name (LIKE match)
3. Check if destination is on the train's route → direct connection
4. If not → check for transfer options (find connecting trains from the last station)

Renders: train info card, route timeline, delay status, and the CTA:
- "Monitoruj przesiadkę — 5 zł" (one-time) → Stripe Checkout
- "Nielimitowany monitoring — 15 zł/msc" → Stripe Checkout (subscription)

### 3. `/cennik` — Pricing

Static page. Two pricing cards (one-time 5 zł + monthly 15 zł). Feature comparison. "Sprawdzanie opóźnień jest zawsze darmowe" callout.

### 4. `/sukces` — Post-payment

Shown after Stripe redirect. Prompts for push notification permission. Registers the `PushSubscription` via API route. Shows the session ID and status.

### 5. `/opoznienia` — Live delays dashboard

Free tool. Reads stats JSON from SQLite. Shows: 4 stat cards (totalTrains, punctuality, avgDelay, cancelled), top 10 delayed trains with real carrier badges, hourly chart. Attribution: "Dane z PKP PLK Otwarte Dane Kolejowe."

This is the engagement/SEO driver — users come here to check delays, discover the transfer monitoring product organically.

---

## 6. Payments

### Stripe (existing live account)

- Product: "niejedzie.pl — Monitor przesiadek" (existing or new)
- Prices:
  - 5 zł one-time (inline `price_data`)
  - 15 zł/month recurring (existing `price_1TH3FRBnylcvivAPES8hepZN` or new)
- Payment methods: Card + BLIK (P24)
- Webhook: `niejedzie.pl/api/webhooks/stripe` handles `checkout.session.completed` → sets monitoring_sessions.payment_status = 'paid', status = 'active'
- Webhook secret: stored in `.env` on VPS

### Flow

```
/wynik CTA click
  → POST /api/checkout/create {mode, trainNumber, destination}
  → Create Stripe Checkout Session
  → Redirect to Stripe
  → User pays
  → Stripe webhook → INSERT/UPDATE monitoring_sessions
  → Redirect to /sukces
  → Browser prompts push permission
  → POST /api/push/subscribe {sessionId, subscription}
  → UPDATE monitoring_sessions SET push_subscription = ?
```

---

## 7. Push notifications

### How monitoring works

1. User pays → monitoring_sessions row created with status='active'
2. `check-push.ts` cron runs every 1 min:
   - SELECT active sessions WHERE status='active' AND operating_date = today
   - For each session: look up the train in active_trains
   - If train's max_delay > threshold (e.g., 15 min) AND push_subscription is set:
     - Call web-push library to send notification
     - Log the push in the session row (last_push_at) to avoid duplicate alerts
3. Session expires at end of operating day (one-time) or continues (subscription)

### VAPID keys

- Public key: environment variable in Next.js (client-side registration)
- Private key: `.env` on VPS (server-side signing)
- Generate fresh pair for v2: `npx web-push generate-vapid-keys`

### Service worker

Minimal `public/sw.js` that listens for `push` events and shows a notification. Registered on `/sukces` page after payment.

---

## 8. Deployment

### Provisioning (one-time, via `hcloud` CLI)

1. Create SSH key: `hcloud ssh-key create --name maciej --public-key-file ~/.ssh/id_ed25519.pub`
2. Create server: `hcloud server create --name niejedzie --type cx22 --image ubuntu-24.04 --location fsn1 --ssh-key maciej`
3. Firewall: allow 80, 443, 22 only
4. DNS: point `niejedzie.pl` A record to VPS IP via Cloudflare (proxied)
5. SSL: Cloudflare handles it (Full Strict mode with origin cert, or just Full mode)

### Server setup

```bash
# On the VPS:
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs sqlite3 nginx certbot
npm install -g pm2

# Clone repo, install deps
git clone git@github.com:bitgeese/niejedzie.git /opt/niejedzie
cd /opt/niejedzie && npm install && npm run build

# PM2 process manager
pm2 start npm --name niejedzie -- start
pm2 save && pm2 startup

# Crontab
crontab -e
# */5 * * * * cd /opt/niejedzie && node scripts/poll-operations.js
# */1 * * * * cd /opt/niejedzie && node scripts/check-push.js
# 0 2 * * * cd /opt/niejedzie && node scripts/sync-routes.js
# 0 3 * * * cd /opt/niejedzie && node scripts/prune.js
```

### Deploy flow (ongoing)

```bash
# From local machine:
ssh niejedzie "cd /opt/niejedzie && git pull && npm install && npm run build && pm2 restart niejedzie"
```

Or: GitHub Actions on push to main → SSH deploy. Reuse the pattern from v1's `deploy.yml`.

---

## 9. What's explicitly NOT in MVP

- City-specific pages (`/opoznienia/warszawa`, etc.)
- Per-train detail pages (`/pociag/[train]`)
- Punctuality statistics (`/punktualnosc`)
- SEO guide pages (jak-sprawdzic-opoznienie, reklamacja-pkp, odszkodowanie)
- User authentication / dashboard
- Email notifications (push only)
- Historical delay data / trends
- Train map
- Multi-language support
- Any managed database (D1, Supabase, PlanetScale, etc.)
- Any per-operation-billed cloud service

All of these are Phase 2+ features. Ship when the SaaS has 10+ paying users.

---

## 10. Success criteria

- [ ] 5 pages live at niejedzie.pl
- [ ] Cron polls PKP API every 5 min, writes to local SQLite
- [ ] `/opoznienia` shows real live data with correct carriers
- [ ] Connection checker (`/wynik`) finds trains and checks routes
- [ ] Stripe Checkout opens from CTA, payment completes
- [ ] Push notification fires when monitored train is delayed
- [ ] Total hosting cost: $4.51/month (Hetzner CX22)
- [ ] Total managed-service cost: $0/month
- [ ] Plausible analytics tracking active
