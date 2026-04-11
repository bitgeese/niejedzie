# niejedzie.pl — reliability fixes + Modal migration

**Date:** 2026-04-11
**Status:** Design approved, ready for implementation plan
**Context:** Follow-up to a browser audit of the production site after today's "2026" train-number bugfix. Audit found one class of cosmetic bugs, one class of data-correctness bugs, and one structural reliability problem with the Cloudflare cron worker. This spec resolves all three and replaces the cron worker with a Modal app to match the operational pattern used by supplementchecker and checkpeptides.

---

## 1. Goals

1. Fix every bug surfaced in the 2026-04-11 browser audit, so the core "check if my train is delayed" loop is accurate end-to-end.
2. Replace the Cloudflare cron worker with a Python Modal app so the PKP API sync work no longer hits Worker time/subrequest limits, aligning niejedzie with the rest of the Modal-based portfolio.
3. Turn on real data for the 8 city pages (currently mocked per `CLAUDE.md` known-issues).
4. Verify the Stripe → push-notification monetization loop works end-to-end, server-side and (with a short user checklist) on a real phone.
5. Re-run the exact same browser audit to confirm every item is fixed before declaring done.

Non-goals:
- Adding new features or pages.
- Refactoring unrelated code.
- Frontend redesign.

---

## 2. Audit findings being addressed

Priority 1 — small fixes (~30 min total):

1. **Carrier missing on `/opoznienia/dzisiaj`.** Every train in the top-delayed list renders as "Nieznany przewoźnik" when the page falls back to D1. The fallback SQL in `src/pages/api/delays/today.ts:139–164` doesn't `SELECT t.carrier`, and the TS handler doesn't include a `carrier` field in the mapped `TopDelayed` row. KV fast-path already carries it. Same bug causes the homepage "live example" widget to show "Nieznany przewoźnik" for train 80436.

2. **Stale "GTFS" footer strings.** `src/pages/wynik.astro` and `src/pages/pociag/[train].astro` both render "Dane z systemu GTFS · Odświeżane codziennie" in the footer. GTFS was removed in commit `ca8a256` — the source is now PKP PLK Open Data API.

3. **`/wynik` shows scheduled arrival instead of actual when delayed.** The big "Przyjazd 12:00:00" box doesn't apply the `+170 min` delay. User reads "train arrives at 12:00" while the actual arrival is ~14:50.

4. **`/wynik` empty state is a dead end.** When the requested train isn't in the `trains` table, the page shows a cute steam-engine icon and "Brak danych o trasie" with only a "Spróbuj ponownie" button. No link back to search, no suggestion to try with carrier prefix, no degraded fallback via `active_trains`.

5. **`/punktualnosc` shows 44.5% network punctuality.** Users land on this page and read that Polish trains are on time less than half the time, which is factually wrong (the real number today is ~88%). Root cause: `daily_stats` was populated during the week of the "2026" bug when `delay_snapshots` contained 24-hour phantom delays. The historical average is poisoned.

Priority 2 — structural (~6–10 hours total):

6. **Cloudflare cron worker keeps hitting time/subrequest limits.** The subagent earlier today flagged that `syncDaily(yesterday)` can't finish in one Worker invocation. The browser audit found a second symptom: `stats:today` KV is intermittently missing, meaning `pollOperations` also sometimes doesn't finish. The Cloudflare Worker platform has a 30-second CPU-time cap and a 1000-subrequest-per-invocation cap. We have been working around these with stream-pagination tricks, but we're at the edge and adding any complexity makes it worse.

7. **City pages still read mock data** (CLAUDE.md Known Issue #1). Warszawa shows 22.9-min average delay vs the real 2.9-min global average — a 10× multiplier that exists only because the page was built against mocks.

8. **Push notification flow has never been e2e tested** (CLAUDE.md Roadmap Phase 3, incomplete). The infrastructure is deployed (service worker, VAPID keys, subscribe endpoint, monitoring_sessions table) but no real user has ever subscribed + received a push on a phone. This is the single biggest product risk — a paying customer could pay 15 zł, miss their train, and learn the hard way that the alert never fires.

---

## 3. Design

### 3.1 Small fixes

**`src/pages/api/delays/today.ts`** — D1 fallback path:
- Add `t.carrier AS carrier` to the `SELECT` in the top-delayed query.
- Add `carrier: r.carrier as string | undefined` to the `topDelayed` row mapping.
- The `TopDelayed` interface already has `carrier?: string`, no type change needed.

**`src/pages/wynik.astro`, `src/pages/pociag/[train].astro`** — footer strings:
- Replace "Dane z systemu GTFS · Odświeżane codziennie" with "Dane z PKP PLK Otwarte Dane Kolejowe · Odświeżane co kilka minut".

**`src/pages/wynik.astro`** — arrival time display:
- Compute `estimatedArrival = plannedArrival + delayMinutes`.
- Show the estimated arrival in the big number with a secondary line showing "planowo {planned} · opóźnienie +{delay} min".
- When delay is 0, just show the scheduled time.

**`src/pages/wynik.astro`** — empty state:
- Replace the single "Spróbuj ponownie" button with three actions:
  1. "Wróć do wyszukiwania" (link to `/gdzie-jest-pociag`)
  2. "Sprawdź opóźnienia dzisiaj" (link to `/opoznienia/dzisiaj`)
  3. Text hint: "Wpisz numer pociągu z prefiksem, np. IC 5313, TLK 31100, EIC 1700"
- Copy change: "Nie znaleźliśmy pociągu {train}. Dane rozkładowe synchronizujemy codziennie o 02:00 — spróbuj ponownie wkrótce."

**`daily_stats` reset** — one-shot SQL:
```sql
DELETE FROM daily_stats WHERE date < '2026-04-11';
```
The dial rebuilds from clean data going forward. Initial readings will be a few datapoints only; fully restored after 12 days of clean accumulation.

**UI copy while data rebuilds:** `src/pages/punktualnosc.astro` already renders the dial from whatever `daily_stats` contains. When fewer than 7 rows are present, add a subtle caption under the dial: "Dane od 11 kwietnia 2026 — pełna historia odbudowuje się codziennie." No hiding the widget; just honest about the window. Once there are ≥7 days of data, the caption auto-disappears.

### 3.2 Modal migration

**Where the code lives:** `projects/pkp-delay-tracker/niejedzie/pipeline/` — matching the supplementchecker and checkpeptides pipeline/ convention.

**Files:**

```
pipeline/
├── modal_cron.py          # Modal app + @app.function definitions + schedules
├── pkp_api.py             # PKP API client (Python port of pkp-api.ts)
├── cf_d1.py               # Cloudflare D1 REST API helper (query, batch)
├── cf_kv.py               # Cloudflare KV REST API helper (get, put)
├── sync_schedules.py      # Port of syncSchedulesForDate + extractTrainNumber
├── poll_operations.py     # Port of pollOperations (stats, topDelayed, batch writes)
├── aggregate_daily.py     # Port of aggregateDaily + backfillCityDaily
└── requirements.txt       # requests, python-dateutil
```

**Modal app definition:**

```python
app = modal.App("niejedzie-cron")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("requests>=2.31", "python-dateutil>=2.8")
    .add_local_file("pkp_api.py", "/root/pkp_api.py")
    .add_local_file("cf_d1.py", "/root/cf_d1.py")
    .add_local_file("cf_kv.py", "/root/cf_kv.py")
    .add_local_file("sync_schedules.py", "/root/sync_schedules.py")
    .add_local_file("poll_operations.py", "/root/poll_operations.py")
    .add_local_file("aggregate_daily.py", "/root/aggregate_daily.py")
)

SECRETS = [
    modal.Secret.from_name("niejedzie-cloudflare"),
    modal.Secret.from_name("niejedzie-pkp"),
]
```

**Scheduled functions:**

| Function | Schedule | Timeout | Retries | What |
|---|---|---|---|---|
| `poll_operations` | `*/5 * * * *` | 300s | 2, exp backoff 10s/20s | Fetch `/api/v1/operations` + `/api/v1/operations/statistics`, stream pages, write `delay_snapshots` + `active_trains`, compute `stats:today` KV |
| `poll_disruptions` | `*/5 * * * *` | 60s | 2, exp backoff 10s/20s | Fetch `/api/v1/disruptions`, write D1 `disruptions` + `disruptions:active` KV |
| `sync_daily` | `0 2 * * *` (UTC) | 900s | 1, 60s delay | Fetch `/api/v1/schedules` for today **and** yesterday, populate `trains`/`train_routes`/`stations`, run aggregation, prune `delay_snapshots` older than 30 days |

Modal's 300s and 900s timeouts are 10–30× more headroom than Cloudflare Workers. The "yesterday sync doesn't finish" and "pollOperations doesn't write KV" problems disappear.

**Cold-start handling:** `poll_operations` runs every 5 minutes, which is short enough that Modal's default container-reuse window keeps it warm most of the time. If we observe cold-start latency eating into the 300s budget, set `keep_warm=1` on that function — adds ~$1-2/month to Modal credit usage, still inside the free tier.

**Modal secrets to create:**

1. **`niejedzie-cloudflare`** — contains:
   - `CF_API_TOKEN` — Cloudflare API token scoped to `D1:Edit` + `Workers KV Storage:Edit` on account `cdffba3e7552f7f10e24305cdce5aa94`
   - `CF_ACCOUNT_ID` — `cdffba3e7552f7f10e24305cdce5aa94`
   - `D1_DATABASE_ID` — `daf01417-76ef-4663-a383-20d2dbb251e3`
   - `KV_NAMESPACE_ID` — `9ed4ec652775490e8e1c3e73e92e4208`
2. **`niejedzie-pkp`** — contains:
   - `PKP_API_KEY` — same value currently bound to the Cloudflare cron worker

**D1 REST API helper** (`cf_d1.py`):

```python
def query(sql: str, params: list | None = None) -> list:
    r = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}/query",
        headers={"Authorization": f"Bearer {CF_API_TOKEN}"},
        json={"sql": sql, "params": params or []},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"D1 query failed: {data.get('errors')}")
    return data["result"][0]["results"]


def batch(statements: list[dict]) -> None:
    """Accept a list of {sql, params} dicts, execute as one batch POST."""
    # D1 REST supports array body, single round-trip for multiple statements
```

**KV REST API helper** (`cf_kv.py`):

```python
def put(key: str, value: str, expiration_ttl: int | None = None) -> None: ...
def get(key: str) -> str | None: ...
```

**Cutover sequence:**

1. Build + deploy Modal (schedules commented out), run each function manually via `modal run`. Verify D1 writes and KV writes land.
2. Dry-run comparison: trigger Modal `poll_operations`, let Cloudflare cron run its normal cycle, diff row counts and `stats:today` content.
3. Enable Modal schedules. Both crons run for ~10 minutes; UNIQUE index on `delay_snapshots` means no duplication.
4. Remove `triggers` from `workers/cron/wrangler.jsonc`, redeploy to disable Cloudflare cron. Worker stays alive for debug endpoints.
5. Monitor for 1 hour: `stats:today` freshness, D1 row counts, `active_trains.updated_at` advancing.
6. Update niejedzie `CLAUDE.md` Backend Architecture + Commands to reflect Modal. Fix the stale "5 cron cap" note in `checkpeptides/CLAUDE.md`.

**Rollback:** restore `triggers` in `wrangler.jsonc` + `wrangler deploy` (30 seconds). Pause Modal via `modal app stop niejedzie-cron`. No data loss either way because both write to the same D1 via `INSERT OR REPLACE`.

**Python implementation parity:**

The Python port must preserve these TS-side behaviors exactly:
- `extractTrainNumber(route)` — `nationalNumber ?? internationalDepartureNumber ?? internationalArrivalNumber ?? name ?? f"{scheduleId}/{orderId}"`. Same precedence and placeholder format.
- Poland timezone date computation — `todayDateStr()` must use `zoneinfo.ZoneInfo("Europe/Warsaw")`, not server-local time. Unit-test by comparing to the TS output at a known instant.
- `delay_snapshots` batch insert uses `INSERT OR REPLACE` on the same columns as the TS worker so the UNIQUE index does its job.
- Non-Scheduled train filter: `if trainStatus == 'S': skip`.
- Stats fusion: identical priority chain — `pkpOfficialStats.totalTrains ?? gtfsRtTotalTrains ?? totalTrains`, etc. (The GTFS-RT fields are dead but harmless to keep in the priority list for now.)

**Observability:**

- Modal's logs UI shows every execution with duration + errors.
- No Telegram alerting for niejedzie (explicitly out of scope: "42 visitors/month, not worth another notification channel").

### 3.3 City pages real data

**Data source decision:** `city_daily` table is already populated (122 rows = 8 cities × ~15 days) by `backfillCityDaily` in the cron. The pages just don't read from it. So this is a frontend-only fix — no new pipeline work needed once Modal is running.

**New queries** added as SSR in `src/pages/opoznienia/[city].astro`:

1. **Today's headline stats:**
   ```sql
   SELECT COUNT(DISTINCT ds.schedule_id || '-' || ds.order_id) AS trains_today,
          ROUND(AVG(COALESCE(ds.arrival_delay, ds.departure_delay, 0)), 1) AS avg_delay,
          ROUND(100.0 * SUM(CASE WHEN COALESCE(ds.arrival_delay, 0) <= 5 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS punctuality
   FROM delay_snapshots ds
   JOIN stations s ON s.station_id = ds.station_id
   WHERE ds.operating_date = ?
     AND s.city LIKE ? || '%'
   ```

2. **Historical 7-day trend from `city_daily`:**
   ```sql
   SELECT date, train_count, avg_delay, punctuality_pct
   FROM city_daily
   WHERE city LIKE ? || '%'
   ORDER BY date DESC LIMIT 7
   ```

3. **Most-delayed-right-now-at-this-city top 10:**
   ```sql
   SELECT t.train_number, t.carrier, t.route_start, t.route_end, MAX(...) AS max_delay
   FROM delay_snapshots ds
   JOIN trains t ON (t.schedule_id, t.order_id) = (ds.schedule_id, ds.order_id)
   JOIN stations s ON s.station_id = ds.station_id
   WHERE ds.operating_date = ? AND s.city LIKE ? || '%'
   GROUP BY ds.schedule_id, ds.order_id
   HAVING max_delay > 0
   ORDER BY max_delay DESC LIMIT 10
   ```

4. **Day-of-week × hour heatmap from last 30 days** (for the existing heatmap widget):
   ```sql
   SELECT strftime('%w', ds.operating_date) AS dow,
          strftime('%H', COALESCE(ds.planned_departure, ds.planned_arrival)) AS hour,
          ROUND(AVG(COALESCE(ds.arrival_delay, ds.departure_delay, 0)), 1) AS avg_delay
   FROM delay_snapshots ds
   JOIN stations s ON s.station_id = ds.station_id
   WHERE ds.operating_date >= date('now', '-30 days')
     AND s.city LIKE ? || '%'
   GROUP BY dow, hour
   ```

**City-to-station mapping caveat:** station names include "Warszawa Centralna", "Warszawa Wschodnia", "Warszawa Gdańska" etc. The match pattern `s.city LIKE ?||'%'` works if `stations.city` was populated via the split-on-first-space heuristic in `syncDaily`. If mapping coverage is off, I'll normalize `stations.city` in a one-shot SQL script before deploying the new page.

**Remove all mock data** from the city page component. Delete the hardcoded constants.

### 3.4 Push notification e2e verification

**Server-side verification** (I do this):

1. Read `src/pages/api/push/subscribe.ts`, the `/api/webhooks/stripe.ts` flow, and any push-send logic in the cron worker. Confirm:
   - `monitoring_sessions` table gets a row on subscribe
   - VAPID private key is set as a Worker secret
   - A code path exists that fetches active monitoring sessions and calls `web-push` (or equivalent) when a delay threshold is exceeded
2. POST a synthetic subscription payload to `/api/push/subscribe`, verify a row lands in `monitoring_sessions` with the right status.
3. Verify the VAPID signing layer: call the push-send code path with a synthetic subscription that points at a local `httpbin.org/post` (or equivalent echo endpoint). Inspect the outgoing request — the `Authorization: vapid t=...` header must be well-formed per RFC 8292, and the encrypted payload must match the subscription's p256dh key. A well-formed request proves the library + keys are wired correctly without needing a real device.
4. Add a temporary `/__trigger/test-push?session={id}` endpoint on the Cloudflare Worker (stays after Modal cutover, for manual testing only) that takes a `monitoring_session_id` and fires a push manually.
5. Report pass/fail for each layer — subscribe → DB row → web-push call → VAPID signature. Only once all four are green do I ask the user to run the client-side checklist.

**Client-side checklist** (user does, ~5 min, after server-side is green):

1. On your phone: Safari → `niejedzie.pl` → share → Add to Home Screen, then open from home screen. (iOS requires PWA install for web push.) Android Chrome: no install needed.
2. Homepage → enter a known train + destination → "Sprawdź połączenie".
3. On `/wynik` → "Monitoruj przesiadkę — 5 zł" → Stripe Checkout → pay with your own card (refundable from Stripe dashboard after).
4. On `/sukces` → grant notification permission when prompted.
5. From any device: open `https://niejedzie-cron.maciej-janowski1.workers.dev/__trigger/test-push?session={yourSessionId}`.
6. A push notification should arrive on your phone within ~10 seconds.

If step 6 works, push is e2e validated. If not, user reports the exact symptom (no prompt, prompt denied, no push, push delayed) and I debug from there.

### 3.5 Verification audit

Re-run the same browser-automation audit performed at 19:30 UTC 2026-04-11, checking every item on the bug list + Modal liveness:

- [ ] Homepage — carrier renders on live-example card for train 80436 (not "Nieznany przewoźnik")
- [ ] `/opoznienia/dzisiaj` — all 10 top-delayed trains show real carrier codes
- [ ] `/opoznienia/dzisiaj` — stats ≈ 88-90% / 2-4 min avg / real cancelled count
- [ ] `/gdzie-jest-pociag` — substring search still works, delay growth chart renders
- [ ] `/wynik?train=60260&destination=Wrocław+Główny` — direct connection detected, big arrival time shows delayed value (~14:50), not scheduled (12:00), carrier rendered
- [ ] `/wynik?train=99999&destination=X` — empty state has 3 action links, not dead end
- [ ] `/cennik` — unchanged
- [ ] `/punktualnosc` — network punctuality no longer 44.5%, shows either (a) accurate recent-only number, or (b) "rebuilding" copy while data accumulates
- [ ] `/opoznienia/warszawa` — avg delay matches global order of magnitude (not 22.9 min)
- [ ] `/pociag/60260` — footer says "Dane z PKP PLK", not "GTFS"
- [ ] Modal: `poll_operations` has logged successful runs for 1 hour, each completing in <300s
- [ ] D1: `stats:today` KV exists and has `timestamp` within last 10 min
- [ ] D1: `delay_snapshots` row count is stable (not climbing — unique index still enforced)
- [ ] Cloudflare cron: triggers removed from `wrangler.jsonc`, worker still responds on `/__trigger/debug-*` endpoints
- [ ] Push: Mozilla autopush test returns 201
- [ ] Push: client-side checklist delivered to user

Each green checkmark → one item from the original audit closed. All 15 → session complete.

---

## 4. What's explicitly out of scope

- No frontend redesign, no new pages, no new features.
- No Telegram alerting for niejedzie.
- No migration of `monitoring_sessions` management or Stripe webhook logic to Modal — those stay on the Cloudflare Worker as HTTP endpoints. Modal only takes over the *scheduled* jobs.
- No historical backfill of `daily_stats` for the pre-2026-04-11 period. The dial rebuilds from clean data forward.
- No automated tests — verification is browser audit + server-side push checks. (Unit tests for `pkp_api.py` helper functions are fine if they come cheap during port.)

---

## 5. Risks and mitigations

| Risk | Detection | Mitigation |
|---|---|---|
| D1 REST API rate-limited on batch writes | Modal function raises 429 | Batch multiple statements per POST, exponential backoff |
| Python `datetime` vs TS `Date` produces off-by-one day for Warsaw tz near midnight | `sync_daily` writes rows with wrong `operating_date` | Explicit `zoneinfo.ZoneInfo("Europe/Warsaw")` and unit test parity with TS worker at a fixture instant |
| PKP API intermittent 530/1016 (same problem subagent hit) | Retry logic catches, success on attempt 2/3 | Port the 3-attempt retry from `pkp-api.ts` directly |
| KV value format differs (JSON stringified by Python vs native object by TS) | Frontend `/api/delays/today` reads malformed data | Test the cached fast-path with a real HTTPS request after enabling Modal |
| City-to-station LIKE pattern has bad coverage | `/opoznienia/warszawa` shows fewer trains than expected | Inspect `stations.city` distribution, normalize via one-shot SQL before shipping the page |
| Stripe webhook or push subscription flow has a latent bug | Server-side verification fails | Report to user before client-side test; do not ask user to spend 5 zł if server-side is broken |
| Modal cold-start delay on every 5-min invocation wastes credit | Observable in Modal dashboard | Use `keep_warm=1` on `poll_operations` to eliminate cold starts — $1-2/month extra at most |

---

## 6. Success criteria

- [ ] All 8 priority-1 audit items fixed and committed.
- [ ] Modal app `niejedzie-cron` deployed, running 3 scheduled functions, stable for 1 hour post-cutover.
- [ ] Cloudflare cron triggers removed; dashboard shows no scheduled runs since cutover timestamp.
- [ ] `niejedzie.pl/api/health` returns `healthy` with `dataAge < 6` for 60 minutes straight post-cutover.
- [ ] All 15 items in §3.5 verification audit pass.
- [ ] niejedzie `CLAUDE.md` + checkpeptides `CLAUDE.md` updated.
- [ ] All commits pushed to `origin/main`.

---

## 7. Rollout order

1. Small fixes (§3.1) first — low risk, immediately visible improvement.
2. City pages (§3.3) — depends only on already-populated `city_daily` + frontend changes.
3. Modal migration (§3.2) — biggest change, done with the cutover plan and rollback path.
4. Push verification (§3.4) — depends on server-side being stable, so after cutover.
5. Verification audit (§3.5) — final gate.
