# niejedzie reliability + Modal migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every audit fix from the 2026-04-11 browser audit (small cosmetic fixes + `/punktualnosc` reset + city pages real data), replace the Cloudflare cron worker with a Python Modal app, server-side verify the push-notification monetization path, and re-run the browser audit to confirm everything works.

**Architecture:** Astro/Cloudflare frontend stays. Cloudflare cron worker is decommissioned and replaced by a new Python Modal app at `projects/pkp-delay-tracker/niejedzie/pipeline/` that writes to Cloudflare D1 + KV via REST APIs. City pages read from the already-populated `city_daily` + live JOIN queries. Push-notification path gets server-side verification via synthetic subscriptions and a new `__trigger/test-push` debug endpoint.

**Tech Stack:** Astro 6 + Cloudflare Workers/D1/KV (frontend), Python 3.12 on Modal (replacement cron), `requests` library, PKP PLK Open Data API, `wrangler` CLI, `modal` CLI.

**Spec:** `docs/superpowers/specs/2026-04-11-niejedzie-reliability-and-modal-design.md`

---

## File Structure

### Files to create

```
pipeline/                                         # new dir — Python Modal app
├── modal_cron.py                                 # @app.function defs + schedules
├── pkp_api.py                                    # PKP API client (port of pkp-api.ts)
├── cf_d1.py                                      # D1 REST API helper
├── cf_kv.py                                      # KV REST API helper
├── sync_schedules.py                             # port of syncSchedulesForDate
├── poll_operations.py                            # port of pollOperations
├── poll_disruptions.py                           # port of pollDisruptions
├── aggregate_daily.py                            # port of aggregateDaily + backfillCityDaily
├── tz_utils.py                                   # Poland-tz date helpers
├── requirements.txt                              # requests, python-dateutil
├── test_pkp_api.py                               # unit tests for retry + extract_train_number
├── test_tz_utils.py                              # unit test for Poland tz parity
└── README.md                                     # deploy + run instructions

src/pages/opoznienia/[city].astro                 # new dynamic city page (replaces 8 individual files)
```

### Files to modify

```
src/pages/api/delays/today.ts                     # add t.carrier to D1 fallback SELECT + mapping
src/pages/wynik.astro                             # arrival time + empty state + footer
src/pages/pociag/[train].astro                    # footer "GTFS" → "PKP PLK"
src/pages/punktualnosc.astro                      # "rebuilding" caption when <7 rows in daily_stats
workers/cron/src/index.ts                         # add /__trigger/test-push endpoint
workers/cron/wrangler.jsonc                       # remove "triggers" (after Modal verified)
CLAUDE.md                                          # (parent pkp-delay-tracker repo) Backend + Commands
../checkpeptides/CLAUDE.md                        # remove stale "5 cron cap" note
```

### Files to delete

```
src/pages/opoznienia/warszawa.astro               # replaced by [city].astro
src/pages/opoznienia/krakow.astro
src/pages/opoznienia/gdansk.astro
src/pages/opoznienia/wroclaw.astro
src/pages/opoznienia/poznan.astro
src/pages/opoznienia/katowice.astro
src/pages/opoznienia/szczecin.astro
src/pages/opoznienia/lodz.astro
```

---

## Phase 1 — Small fixes (ship first, 30 min)

### Task 1: Carrier missing on /opoznienia/dzisiaj

**Files:**
- Modify: `src/pages/api/delays/today.ts:139-171`

- [ ] **Step 1: Read current file around the fallback SELECT**

```bash
sed -n '135,175p' src/pages/api/delays/today.ts
```

- [ ] **Step 2: Add `t.carrier` to the SELECT and include carrier in the row mapping**

Replace lines 139–164 with:

```typescript
    // Top delayed trains — subquery to get the station with the actual max delay
    const topRows = await env.DB.prepare(`
      SELECT
        agg.schedule_id,
        agg.order_id,
        COALESCE(t.train_number, agg.schedule_id || '/' || agg.order_id) AS train_number,
        t.carrier AS carrier,
        agg.max_delay,
        COALESCE(t.route_start || ' \u2192 ' || t.route_end, '') AS route,
        COALESCE(detail.station_name, '') AS station_name
      FROM (
        SELECT schedule_id, order_id,
               MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay
        FROM delay_snapshots
        WHERE operating_date = ?
        GROUP BY schedule_id, order_id
        HAVING max_delay > 0
      ) agg
      LEFT JOIN trains t
        ON t.schedule_id = agg.schedule_id AND t.order_id = agg.order_id
      LEFT JOIN delay_snapshots detail
        ON detail.schedule_id = agg.schedule_id
        AND detail.order_id = agg.order_id
        AND detail.operating_date = ?
        AND COALESCE(detail.arrival_delay, detail.departure_delay, 0) = agg.max_delay
      ORDER BY agg.max_delay DESC
      LIMIT 10
    `).bind(today, today).all();
```

Replace the mapping at lines 166–171 with:

```typescript
    const topDelayed: TopDelayed[] = (topRows.results || []).map((r) => ({
      trainNumber: r.train_number as string,
      delay: r.max_delay as number,
      route: r.route as string,
      station: (r.station_name as string) || '',
      carrier: (r.carrier as string) || undefined,
    }));
```

- [ ] **Step 3: Verify `TopDelayed` interface already has `carrier?: string` (it does at line 23–29 of the same file). No type change needed.**

- [ ] **Step 4: Build + deploy Astro**

```bash
rm -rf dist .wrangler && npm run build && cd dist/server && npx wrangler deploy
```

Expected: `Uploaded niejedzie`, `Deployed niejedzie triggers`.

- [ ] **Step 5: Verify with curl — force D1 fallback by hitting after KV TTL or use a fresh query**

```bash
curl -s 'https://niejedzie.pl/api/delays/today' | python3 -c "import sys,json; d=json.load(sys.stdin); print('sample carriers:', [t.get('carrier') for t in d['topDelayed'][:5]])"
```

Expected: a list with real values like `['PR', 'IC', 'KD', ...]`, not `[None, None, None, ...]`.

- [ ] **Step 6: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
git add src/pages/api/delays/today.ts
git commit -m "fix: include carrier in /api/delays/today D1 fallback"
git push
```

---

### Task 2: Stale "GTFS" footer strings

**Files:**
- Modify: `src/pages/wynik.astro` (around line 381)
- Modify: `src/pages/pociag/[train].astro` (around line 169)

- [ ] **Step 1: Find exact current strings**

```bash
grep -n "GTFS" src/pages/wynik.astro src/pages/pociag/\[train\].astro
```

Expected: two or more matches referencing "Dane z systemu GTFS" etc.

- [ ] **Step 2: Replace in wynik.astro**

Replace the string `Dane z systemu GTFS-RT · Odświeżane co kilka minut` (or whatever variant is present) with:

```
Dane z PKP PLK Otwarte Dane Kolejowe · Odświeżane co kilka minut
```

- [ ] **Step 3: Replace in pociag/[train].astro**

Replace `Dane z systemu GTFS · Odświeżane codziennie` with:

```
Dane z PKP PLK Otwarte Dane Kolejowe · Odświeżane codziennie
```

- [ ] **Step 4: Grep again to confirm no stragglers**

```bash
grep -rn "GTFS\|mkuran\|Portal Pasa" src/pages/
```

Expected: no matches except inside user-facing guide content at `jak-sprawdzic-opoznienie.astro` (that's legit content, leave it).

- [ ] **Step 5: Commit**

```bash
git add src/pages/wynik.astro src/pages/pociag/\[train\].astro
git commit -m "fix: replace stale GTFS footer strings with PKP PLK attribution"
git push
```

---

### Task 3: /wynik big-number shows actual arrival when delayed

**Files:**
- Modify: `src/pages/wynik.astro` (the `direct` connection display block, roughly lines 100–200 — find with grep)

- [ ] **Step 1: Locate the big-arrival-time rendering block**

```bash
grep -n "12:00:00\|Przyjazd\|direct\.arrivalTime\|arrivalTime" src/pages/wynik.astro | head -20
```

- [ ] **Step 2: Find where the `data.direct.arrivalTime` is rendered as the big number. Read the surrounding 30 lines to understand context.**

```bash
grep -n "data.direct\|Przyjazd" src/pages/wynik.astro
```

- [ ] **Step 3: Add a helper right after `const trainParam` (top of the file)**

```typescript
function addDelayToTime(hhmm: string | null, delayMin: number): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const totalMinutes = h * 60 + m + delayMin;
  const newH = Math.floor((totalMinutes % 1440 + 1440) % 1440 / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}
```

- [ ] **Step 4: In the direct-connection render block, replace the big arrival time with delay-aware version**

Find the JSX/template line that shows `{data.direct.arrivalTime}` as the big time. Replace with something like:

```astro
{data.train.maxDelay > 0 ? (
  <>
    <div class="text-5xl font-mono font-bold text-delay-high">
      ~{addDelayToTime(data.direct.arrivalTime, data.train.maxDelay)}
    </div>
    <div class="text-sm text-ink-500 mt-1">
      planowo {data.direct.arrivalTime} · +{data.train.maxDelay} min
    </div>
  </>
) : (
  <div class="text-5xl font-mono font-bold">{data.direct.arrivalTime}</div>
)}
```

Match the existing class naming conventions — grep for `text-5xl` or similar in the file to find the right classes.

- [ ] **Step 5: Build + deploy**

```bash
rm -rf dist .wrangler && npm run build && cd dist/server && npx wrangler deploy
```

- [ ] **Step 6: Verify**

```bash
curl -sI 'https://niejedzie.pl/wynik?train=60260&destination=Wroc%C5%82aw+G%C5%82%C3%B3wny' | head -5
# Then open in browser or use claude-in-chrome browser automation to see the big number
```

Expected: the rendered page shows "~14:50" as the big number for train 60260 (which has +170 min delay), with "planowo 12:00 · +170 min" subline.

- [ ] **Step 7: Commit**

```bash
git add src/pages/wynik.astro
git commit -m "fix: show actual arrival time when train is delayed on /wynik"
git push
```

---

### Task 4: /wynik empty state

**Files:**
- Modify: `src/pages/wynik.astro` (the `type === 'not_found'` or `type === 'no_route'` branch)

- [ ] **Step 1: Find the empty-state render block**

```bash
grep -n "not_found\|Brak danych\|no_route\|Spróbuj ponownie" src/pages/wynik.astro
```

- [ ] **Step 2: Replace the single-button empty state with a three-action block**

Find the block that currently renders the train cartoon + "Brak danych o trasie" + "Spróbuj ponownie" button. Replace it with:

```astro
<div class="text-center py-16">
  <div class="text-6xl mb-6">🚂</div>
  <h2 class="text-2xl font-bold mb-3">
    {data.type === 'not_found' ? `Nie znaleźliśmy pociągu ${trainParam}` : 'Brak danych o trasie'}
  </h2>
  <p class="text-ink-500 mb-8 max-w-md mx-auto">
    Dane rozkładowe synchronizujemy codziennie o 02:00 — spróbuj ponownie za kilka minut lub
    wpisz pełny numer pociągu z prefiksem (np. IC 5313, TLK 31100, EIC 1700).
  </p>
  <div class="flex flex-wrap gap-3 justify-center">
    <a href="/gdzie-jest-pociag" class="px-6 py-3 bg-brand-500 hover:bg-brand-600 text-white font-bold rounded-xl transition">
      Wróć do wyszukiwania
    </a>
    <a href="/opoznienia/dzisiaj" class="px-6 py-3 bg-surface-100 hover:bg-surface-200 text-ink-900 font-bold rounded-xl transition">
      Opóźnienia dzisiaj
    </a>
    <a href="/" class="px-6 py-3 bg-surface-100 hover:bg-surface-200 text-ink-900 font-bold rounded-xl transition">
      Strona główna
    </a>
  </div>
</div>
```

Use existing design tokens — check `src/styles/global.css` for the actual brand color classes if the above don't match.

- [ ] **Step 3: Build + deploy**

```bash
rm -rf dist .wrangler && npm run build && cd dist/server && npx wrangler deploy
```

- [ ] **Step 4: Verify with a known-missing train**

```bash
curl -s 'https://niejedzie.pl/wynik?train=99999&destination=Warszawa' | grep -c 'Wróć do wyszukiwania'
```

Expected: `1` (link is present).

- [ ] **Step 5: Commit**

```bash
git add src/pages/wynik.astro
git commit -m "fix: replace /wynik dead-end empty state with three action links"
git push
```

---

### Task 5: Reset daily_stats + add rebuilding caption

**Files:**
- D1 database (one-shot SQL)
- Modify: `src/pages/punktualnosc.astro`

- [ ] **Step 1: Count current daily_stats rows to confirm the scope of the delete**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "SELECT COUNT(*) as total, MIN(date) as first, MAX(date) as last FROM daily_stats"
```

Expected: some count (probably 15-30 rows), first date before 2026-04-11, last date today.

- [ ] **Step 2: Delete poisoned rows**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "DELETE FROM daily_stats WHERE date < '2026-04-11'"
```

Expected: `changes: N` where N ≥ 1.

- [ ] **Step 3: Verify only clean rows remain**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "SELECT date, punctuality_pct, avg_delay FROM daily_stats ORDER BY date DESC"
```

Expected: 0–2 rows showing dates 2026-04-11 or later.

- [ ] **Step 4: Read `src/pages/punktualnosc.astro` to find where the SSR query loads `daily_stats`**

```bash
head -60 src/pages/punktualnosc.astro
```

Find the query that pulls from `daily_stats`. Note the variable name holding the results.

- [ ] **Step 5: Add a "rebuilding" caption when fewer than 7 rows are loaded**

Find the JSX block that renders the punctuality dial. Right under it, add:

```astro
{dailyStats.length < 7 && (
  <p class="text-xs text-ink-400 mt-2 text-center italic">
    Dane od 11 kwietnia 2026 — pełna historia 12 miesięcy odbudowuje się codziennie
    (aktualnie {dailyStats.length} {dailyStats.length === 1 ? 'dzień' : 'dni'}).
  </p>
)}
```

Replace `dailyStats` with the actual variable name from Step 4.

- [ ] **Step 6: Build + deploy**

```bash
rm -rf dist .wrangler && npm run build && cd dist/server && npx wrangler deploy
```

- [ ] **Step 7: Verify**

```bash
curl -s 'https://niejedzie.pl/punktualnosc' | grep -c 'odbudowuje się codziennie'
```

Expected: `1` while `daily_stats` has <7 rows.

- [ ] **Step 8: Commit**

```bash
git add src/pages/punktualnosc.astro
git commit -m "fix: add rebuilding caption on /punktualnosc while daily_stats has <7 rows

Paired with a one-shot DELETE from daily_stats WHERE date < '2026-04-11'
to purge historical rows poisoned by the 2026 train-number bug era.
The widget keeps rendering — honest about the window, rather than hiding."
git push
```

---

## Phase 2 — City pages real data (1 hour)

### Task 6: Inspect stations.city coverage

**Files:** none (investigation only)

- [ ] **Step 1: Check distribution of `stations.city` for each of 8 target cities**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "SELECT city, COUNT(*) as stations FROM stations WHERE city LIKE 'Warszawa%' OR city LIKE 'Kraków%' OR city LIKE 'Gdańsk%' OR city LIKE 'Wrocław%' OR city LIKE 'Poznań%' OR city LIKE 'Katowice%' OR city LIKE 'Szczecin%' OR city LIKE 'Łódź%' GROUP BY city ORDER BY stations DESC LIMIT 30"
```

- [ ] **Step 2: Note the results. Decide which LIKE pattern is safest per city.**

Example expected output structure:
```
Warszawa Centralna  | 1
Warszawa Wschodnia  | 1
Kraków Główny       | 1
...
```

Or the `city` column might literally contain "Warszawa" for multiple stations. Either works for the query below — the key is whether `WHERE s.city LIKE 'Warszawa%'` catches all Warsaw stations.

- [ ] **Step 3: If coverage looks bad (e.g., `city` column is NULL for many rows), run a normalization pass**

Only run this if step 1 reveals NULL or malformed city values:

```bash
npx wrangler d1 execute niejedzie-db --remote --command "UPDATE stations SET city = trim(substr(name, 1, instr(name || ' ', ' ') - 1)) WHERE city IS NULL OR city = ''"
```

This sets `city` to the first word of `name`. Safe idempotent.

- [ ] **Step 4: Re-run step 1 to verify coverage is healthy**

Expected: Warszawa has ≥ 5 stations, Kraków ≥ 3, Gdańsk ≥ 2, etc.

- [ ] **Step 5: No commit yet — this task produced no file changes.**

---

### Task 7: Create dynamic [city].astro page

**Files:**
- Create: `src/pages/opoznienia/[city].astro`

- [ ] **Step 1: Read one of the existing city pages to understand the layout/components**

```bash
head -100 src/pages/opoznienia/warszawa.astro
```

Note which components are imported (`StatCard`, `TrainOperator`, etc.) and the high-level page structure.

- [ ] **Step 2: Create the dynamic page with `getStaticPaths` + SSR data**

Create `src/pages/opoznienia/[city].astro` with this content. Replace any component imports that don't exist with the ones you see in step 1.

```astro
---
export const prerender = false;
import Base from '../../layouts/Base.astro';
import { env } from 'cloudflare:workers';
import { getPolandDate } from '../../lib/time-utils';

// Supported cities with display name + match pattern
const CITIES: Record<string, { displayName: string; pattern: string }> = {
  warszawa:  { displayName: 'Warszawa',  pattern: 'Warszawa%' },
  krakow:    { displayName: 'Kraków',    pattern: 'Kraków%' },
  gdansk:    { displayName: 'Gdańsk',    pattern: 'Gdańsk%' },
  wroclaw:   { displayName: 'Wrocław',   pattern: 'Wrocław%' },
  poznan:    { displayName: 'Poznań',    pattern: 'Poznań%' },
  katowice:  { displayName: 'Katowice',  pattern: 'Katowice%' },
  szczecin:  { displayName: 'Szczecin',  pattern: 'Szczecin%' },
  lodz:      { displayName: 'Łódź',      pattern: 'Łódź%' },
};

const citySlug = (Astro.params.city || '').toLowerCase();
const cityInfo = CITIES[citySlug];

if (!cityInfo) {
  return new Response('City not found', { status: 404 });
}

const today = getPolandDate();

// 1. Today's headline stats
const headlineRow = await env.DB.prepare(`
  SELECT
    COUNT(DISTINCT ds.schedule_id || '-' || ds.order_id) AS trains_today,
    ROUND(AVG(COALESCE(ds.arrival_delay, ds.departure_delay, 0)), 1) AS avg_delay,
    ROUND(
      100.0 * SUM(CASE WHEN COALESCE(ds.arrival_delay, 0) <= 5 THEN 1 ELSE 0 END)
      / MAX(COUNT(*), 1),
      1
    ) AS punctuality
  FROM delay_snapshots ds
  JOIN stations s ON s.station_id = ds.station_id
  WHERE ds.operating_date = ?
    AND s.city LIKE ?
`).bind(today, cityInfo.pattern).first();

const stats = {
  trainsToday: (headlineRow?.trains_today as number) || 0,
  avgDelay: (headlineRow?.avg_delay as number) || 0,
  punctuality: (headlineRow?.punctuality as number) || 0,
};

// 2. Historical 7-day trend from city_daily
const historyRows = await env.DB.prepare(`
  SELECT date, train_count, avg_delay, punctuality_pct
  FROM city_daily
  WHERE city LIKE ?
  ORDER BY date DESC
  LIMIT 7
`).bind(cityInfo.pattern).all();

const history = (historyRows.results || []).map((r: any) => ({
  date: r.date as string,
  trainCount: r.train_count as number,
  avgDelay: r.avg_delay as number,
  punctuality: r.punctuality_pct as number,
})).reverse();

// 3. Most-delayed-right-now-at-this-city top 10
const topDelayedRows = await env.DB.prepare(`
  SELECT
    COALESCE(t.train_number, ds.schedule_id || '/' || ds.order_id) AS train_number,
    t.carrier AS carrier,
    COALESCE(t.route_start || ' → ' || t.route_end, '') AS route,
    MAX(COALESCE(ds.arrival_delay, ds.departure_delay, 0)) AS max_delay
  FROM delay_snapshots ds
  LEFT JOIN trains t ON (t.schedule_id = ds.schedule_id AND t.order_id = ds.order_id)
  JOIN stations s ON s.station_id = ds.station_id
  WHERE ds.operating_date = ?
    AND s.city LIKE ?
  GROUP BY ds.schedule_id, ds.order_id
  HAVING max_delay > 0
  ORDER BY max_delay DESC
  LIMIT 10
`).bind(today, cityInfo.pattern).all();

const topDelayed = (topDelayedRows.results || []).map((r: any) => ({
  trainNumber: r.train_number as string,
  carrier: (r.carrier as string) || '',
  route: r.route as string,
  delay: r.max_delay as number,
}));
---
<Base title={`Opóźnienia pociągów ${cityInfo.displayName} — na żywo | niejedzie.pl`}>
  <section class="py-16 px-6 bg-ink-900 text-white">
    <div class="max-w-5xl mx-auto">
      <a href="/opoznienia/dzisiaj" class="text-ink-400 hover:text-white text-sm">
        ← Wszystkie miasta
      </a>
      <div class="text-xs font-mono text-ink-500 mt-4 mb-2">// OPÓŹNIENIA NA ŻYWO</div>
      <h1 class="text-5xl font-bold">{cityInfo.displayName}</h1>
      <p class="text-ink-400 mt-2">Dane z PKP PLK odświeżane co kilka minut · {today}</p>
    </div>
    <div class="max-w-5xl mx-auto mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="bg-ink-800 p-6 rounded-xl">
        <div class="text-4xl font-bold">{stats.trainsToday}</div>
        <div class="text-xs font-mono text-ink-400 mt-1">POCIĄGÓW DZIŚ</div>
      </div>
      <div class="bg-ink-800 p-6 rounded-xl">
        <div class="text-4xl font-bold text-brand-500">{stats.avgDelay} min</div>
        <div class="text-xs font-mono text-ink-400 mt-1">ŚR. OPÓŹNIENIE</div>
      </div>
      <div class="bg-ink-800 p-6 rounded-xl">
        <div class="text-4xl font-bold text-green-400">{stats.punctuality}%</div>
        <div class="text-xs font-mono text-ink-400 mt-1">PUNKTUALNOŚĆ</div>
      </div>
    </div>
  </section>

  <section class="py-16 px-6">
    <div class="max-w-5xl mx-auto">
      <div class="text-xs font-mono text-ink-500 mb-2">// NAJBARDZIEJ OPÓŹNIONE</div>
      <h2 class="text-3xl font-bold mb-6">Najbardziej opóźnione pociągi w {cityInfo.displayName}</h2>
      {topDelayed.length === 0 ? (
        <p class="text-ink-500">Brak opóźnionych pociągów w tej chwili — wszystko jedzie na czas.</p>
      ) : (
        <ul class="space-y-3">
          {topDelayed.map((t) => (
            <li class="flex items-center gap-4 p-4 bg-surface-100 rounded-xl">
              <div class="font-mono font-bold text-lg">{t.trainNumber}</div>
              <div class="text-xs text-ink-500">{t.carrier || 'Nieznany przewoźnik'}</div>
              <div class="flex-1 text-sm text-ink-600">{t.route}</div>
              <div class="font-mono text-brand-500 font-bold">+{t.delay} min</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  </section>

  <section class="py-16 px-6 bg-surface-50">
    <div class="max-w-5xl mx-auto">
      <div class="text-xs font-mono text-ink-500 mb-2">// HISTORIA 7 DNI</div>
      <h2 class="text-3xl font-bold mb-6">Punktualność w {cityInfo.displayName} — ostatnie 7 dni</h2>
      {history.length === 0 ? (
        <p class="text-ink-500">Brak danych historycznych — zacznij zbierać po 02:00 jutro.</p>
      ) : (
        <ul class="space-y-2">
          {history.map((d) => (
            <li class="grid grid-cols-4 gap-4 py-3 border-b border-ink-100">
              <div class="font-mono text-sm">{d.date}</div>
              <div class="text-sm">{d.trainCount} pociągów</div>
              <div class="text-sm text-brand-500">{d.avgDelay} min śr.</div>
              <div class="text-sm text-green-600">{d.punctuality}%</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  </section>
</Base>
```

- [ ] **Step 3: `getStaticPaths` is NOT needed because `export const prerender = false` runs SSR per request. Verify the page file is correct by local type-check**

```bash
npx astro check 2>&1 | tail -20
```

Expected: 0 errors, or only errors in unrelated files.

- [ ] **Step 4: Build (don't deploy yet — we'll delete the 8 old files first)**

```bash
rm -rf dist .wrangler && npm run build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/opoznienia/\[city\].astro
git commit -m "feat: add dynamic /opoznienia/[city].astro with real data"
git push
```

---

### Task 8: Delete the 8 hardcoded city pages + deploy

**Files:**
- Delete: `src/pages/opoznienia/{warszawa,krakow,gdansk,wroclaw,poznan,katowice,szczecin,lodz}.astro`

- [ ] **Step 1: Delete the 8 individual files**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
rm src/pages/opoznienia/warszawa.astro \
   src/pages/opoznienia/krakow.astro \
   src/pages/opoznienia/gdansk.astro \
   src/pages/opoznienia/wroclaw.astro \
   src/pages/opoznienia/poznan.astro \
   src/pages/opoznienia/katowice.astro \
   src/pages/opoznienia/szczecin.astro \
   src/pages/opoznienia/lodz.astro
```

- [ ] **Step 2: Build + deploy**

```bash
rm -rf dist .wrangler && npm run build && cd dist/server && npx wrangler deploy
```

Expected: build succeeds, deploy succeeds.

- [ ] **Step 3: Verify all 8 cities resolve via the dynamic route**

```bash
for city in warszawa krakow gdansk wroclaw poznan katowice szczecin lodz; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://niejedzie.pl/opoznienia/$city")
  echo "$city: $code"
done
```

Expected: every city returns `200`.

- [ ] **Step 4: Visual verify — Warszawa should show real numbers, not mock 22.9 min**

```bash
curl -s 'https://niejedzie.pl/opoznienia/warszawa' | grep -oE 'min|%' | head -10
```

Or use `claude-in-chrome` browser automation to screenshot `/opoznienia/warszawa` and confirm avg delay is <10 min.

- [ ] **Step 5: Commit**

```bash
git add -A src/pages/opoznienia/
git commit -m "feat: replace 8 hardcoded city pages with dynamic [city].astro"
git push
```

---

## Phase 3 — Modal migration (~6 hours)

### Task 9: Create pipeline scaffolding + requirements

**Files:**
- Create: `pipeline/requirements.txt`
- Create: `pipeline/README.md`

- [ ] **Step 1: Create pipeline directory**

```bash
mkdir -p pipeline
```

- [ ] **Step 2: Write `pipeline/requirements.txt`**

```txt
requests>=2.31
python-dateutil>=2.8
```

- [ ] **Step 3: Write `pipeline/README.md`**

```markdown
# niejedzie Modal pipeline

Python Modal app replacing the old Cloudflare cron worker. Writes to D1 and KV via Cloudflare REST APIs.

## Secrets required

- `niejedzie-cloudflare` — `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `KV_NAMESPACE_ID`
- `niejedzie-pkp` — `PKP_API_KEY`

## Deploy

```bash
cd pipeline
modal deploy modal_cron.py
```

## Manual runs

```bash
modal run modal_cron.py::poll_operations
modal run modal_cron.py::poll_disruptions
modal run modal_cron.py::sync_daily
```

## Schedules (UTC)

- `poll_operations` — every 5 min
- `poll_disruptions` — every 5 min
- `sync_daily` — daily 02:00
```

- [ ] **Step 4: Commit**

```bash
git add pipeline/
git commit -m "feat(pipeline): scaffold Modal app directory"
```

---

### Task 10: Port pkp_api.py with retry logic

**Files:**
- Create: `pipeline/pkp_api.py`
- Create: `pipeline/test_pkp_api.py`

Reference source: `workers/cron/src/pkp-api.ts` (281 lines, port these semantics exactly).

- [ ] **Step 1: Write the test file first (TDD)**

Create `pipeline/test_pkp_api.py`:

```python
"""Unit tests for pkp_api.py — extract_train_number and retry logic."""
from unittest.mock import patch, MagicMock
import pkp_api


def test_extract_train_number_prefers_national_number():
    route = {"nationalNumber": "49015", "name": None, "scheduleId": 2026, "orderId": 12345}
    assert pkp_api.extract_train_number(route) == "49015"


def test_extract_train_number_falls_through_to_international_departure():
    route = {
        "nationalNumber": None,
        "internationalDepartureNumber": "5680",
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "5680"


def test_extract_train_number_falls_through_to_international_arrival():
    route = {
        "nationalNumber": None,
        "internationalDepartureNumber": None,
        "internationalArrivalNumber": "5387",
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "5387"


def test_extract_train_number_falls_through_to_name():
    route = {
        "nationalNumber": None,
        "name": "KASZTELAN",
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "KASZTELAN"


def test_extract_train_number_compound_placeholder():
    route = {
        "nationalNumber": None,
        "internationalDepartureNumber": None,
        "internationalArrivalNumber": None,
        "name": None,
        "scheduleId": 2026,
        "orderId": 12345,
    }
    assert pkp_api.extract_train_number(route) == "2026/12345"


def test_extract_train_number_strips_whitespace():
    route = {"nationalNumber": "  49015  ", "scheduleId": 2026, "orderId": 12345}
    assert pkp_api.extract_train_number(route) == "49015"


def test_extract_train_number_rejects_empty_string():
    # Empty string should fall through, not be used
    route = {"nationalNumber": "", "name": "FOO", "scheduleId": 2026, "orderId": 12345}
    assert pkp_api.extract_train_number(route) == "FOO"


@patch("pkp_api.requests.get")
def test_pkp_fetch_retries_on_5xx(mock_get):
    mock_500 = MagicMock(status_code=530, text="cf edge 1016")
    mock_500.ok = False
    mock_200 = MagicMock(status_code=200, ok=True)
    mock_200.json.return_value = {"routes": []}
    mock_get.side_effect = [mock_500, mock_200]

    result = pkp_api.pkp_fetch("/api/v1/schedules", "fake-key", {})
    assert result == {"routes": []}
    assert mock_get.call_count == 2


@patch("pkp_api.requests.get")
def test_pkp_fetch_gives_up_on_4xx(mock_get):
    mock_401 = MagicMock(status_code=401, text="unauthorized")
    mock_401.ok = False
    mock_get.return_value = mock_401

    result = pkp_api.pkp_fetch("/api/v1/schedules", "fake-key", {})
    assert result is None
    assert mock_get.call_count == 1
```

- [ ] **Step 2: Write `pipeline/pkp_api.py`**

```python
"""PKP PLK Open Data API client — Python port of workers/cron/src/pkp-api.ts.

Preserves:
- 3-attempt retry with linear backoff for 5xx / network errors (no retry on 4xx)
- extract_train_number precedence: nationalNumber → internationalDepartureNumber →
  internationalArrivalNumber → name → compound {scheduleId}/{orderId}
"""
from __future__ import annotations

import time
from typing import Any, Callable, Iterator

import requests

PKP_API_BASE = "https://pdp-api.plk-sa.pl"
MAX_ATTEMPTS = 3


def pkp_fetch(
    path: str,
    api_key: str,
    params: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> dict | None:
    """Fetch a PKP API path with retry. Returns parsed JSON or None on failure."""
    url = PKP_API_BASE + path
    headers = {"X-API-Key": api_key, "Accept": "application/json"}

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            r = requests.get(url, headers=headers, params=params or {}, timeout=timeout)
            if r.ok:
                return r.json()
            # Give up immediately on 4xx (auth / bad request). Retry on 5xx / network.
            if r.status_code < 500 or attempt == MAX_ATTEMPTS:
                print(
                    f"[pkp_fetch] {r.status_code} {r.reason} for {path} "
                    f"(attempt {attempt}/{MAX_ATTEMPTS})"
                )
                return None
            print(f"[pkp_fetch] {r.status_code} on {path}, retrying")
        except requests.RequestException as e:
            if attempt == MAX_ATTEMPTS:
                print(f"[pkp_fetch] network error on {path}: {e}")
                return None
            print(f"[pkp_fetch] network error on {path}, retrying: {e}")
        # Linear backoff: 500ms, 1000ms
        time.sleep(0.5 * attempt)
    return None


def extract_train_number(route: dict) -> str:
    """Return the real train number for a /schedules route.

    Precedence matches workers/cron/src/index.ts:extractTrainNumber exactly:
    nationalNumber → internationalDepartureNumber → internationalArrivalNumber →
    name → compound {scheduleId}/{orderId} (last-resort placeholder).
    """
    for key in (
        "nationalNumber",
        "internationalDepartureNumber",
        "internationalArrivalNumber",
        "name",
    ):
        value = route.get(key)
        if value is not None and isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
    return f"{route['scheduleId']}/{route['orderId']}"


def fetch_operations_pages(
    api_key: str,
    on_page: Callable[[list[dict], dict[str, str], int], None],
) -> dict:
    """Stream paged /api/v1/operations, calling on_page(trains, stations, page_num) per page.

    Returns {'total_trains': N, 'stations': {id: name}}.
    Matches workers/cron/src/pkp-api.ts:fetchOperationsPages semantics.
    """
    all_stations: dict[str, str] = {}
    total_trains = 0
    page = 1
    page_size = 2000
    max_pages = 100

    while page <= max_pages:
        res = pkp_fetch(
            "/api/v1/operations",
            api_key,
            {
                "fullRoutes": "true",
                "withPlanned": "true",
                "page": str(page),
                "pageSize": str(page_size),
            },
        )
        if not res or not res.get("trains"):
            if page == 1:
                print("[fetch_operations_pages] no data on first page")
            break

        all_stations.update(res.get("stations", {}))
        trains = res["trains"]
        total_trains += len(trains)
        on_page(trains, all_stations, page)

        if not res.get("pagination", {}).get("hasNextPage"):
            break
        page += 1

    print(f"[fetch_operations_pages] processed {total_trains} trains across {page} pages")
    return {"total_trains": total_trains, "stations": all_stations}


def fetch_statistics(api_key: str, date: str) -> dict | None:
    """GET /api/v1/operations/statistics?date=YYYY-MM-DD"""
    return pkp_fetch("/api/v1/operations/statistics", api_key, {"date": date})


def fetch_schedules_pages(
    api_key: str,
    date: str,
    on_page: Callable[[list[dict], dict[str, str], int], None],
) -> dict:
    """Stream paged /api/v1/schedules for a single date. Accumulates dictionaries across pages."""
    all_stations: dict[str, str] = {}
    all_carriers: dict[str, str] = {}
    total_routes = 0
    page = 1
    page_size = 1000
    max_pages = 100

    while page <= max_pages:
        res = pkp_fetch(
            "/api/v1/schedules",
            api_key,
            {
                "dateFrom": date,
                "dateTo": date,
                "dictionaries": "true",
                "page": str(page),
                "pageSize": str(page_size),
            },
        )
        if not res or not res.get("routes"):
            if page == 1:
                print("[fetch_schedules_pages] no data on first page")
            break

        dictionaries = res.get("dictionaries") or {}
        stations_dict = dictionaries.get("stations") or {}
        for sid, info in stations_dict.items():
            all_stations[str(sid)] = info["name"] if isinstance(info, dict) else info
        all_carriers.update(dictionaries.get("carriers") or {})

        routes = res["routes"]
        total_routes += len(routes)
        on_page(routes, all_stations, page)

        if len(routes) < page_size:
            break
        page += 1

    return {"total_routes": total_routes, "stations": all_stations, "carriers": all_carriers}


def fetch_disruptions(api_key: str) -> list[dict]:
    """GET /api/v1/disruptions. Returns list or empty on failure."""
    res = pkp_fetch("/api/v1/disruptions", api_key)
    if not res or not res.get("success") or not res.get("data", {}).get("disruptions"):
        return []
    return res["data"]["disruptions"]
```

- [ ] **Step 3: Run the tests**

```bash
cd pipeline
python3 -m pip install requests python-dateutil pytest
python3 -m pytest test_pkp_api.py -v
```

Expected: 9 tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
git add pipeline/pkp_api.py pipeline/test_pkp_api.py
git commit -m "feat(pipeline): port pkp_api.py with extract_train_number + retry"
```

---

### Task 11: Port tz_utils.py with Poland-tz parity test

**Files:**
- Create: `pipeline/tz_utils.py`
- Create: `pipeline/test_tz_utils.py`

- [ ] **Step 1: Write the test file first**

```python
"""Parity test: tz_utils.today_date_str matches the TS worker's todayDateStr."""
from datetime import datetime
from unittest.mock import patch
import tz_utils


def test_today_date_str_returns_warsaw_date():
    """At 2026-06-01 22:30 UTC, Warsaw is already 2026-06-02 00:30 (summer time UTC+2)."""
    fake_now = datetime(2026, 6, 1, 22, 30, 0)  # UTC
    with patch("tz_utils.datetime") as mock_dt:
        mock_dt.now.return_value = fake_now.replace(tzinfo=tz_utils.timezone.utc)
        mock_dt.side_effect = lambda *args, **kw: datetime(*args, **kw)
        assert tz_utils.today_date_str() == "2026-06-02"


def test_today_date_str_winter_time():
    """At 2026-01-01 22:30 UTC, Warsaw is 2026-01-01 23:30 (winter time UTC+1)."""
    fake_now = datetime(2026, 1, 1, 22, 30, 0)
    with patch("tz_utils.datetime") as mock_dt:
        mock_dt.now.return_value = fake_now.replace(tzinfo=tz_utils.timezone.utc)
        mock_dt.side_effect = lambda *args, **kw: datetime(*args, **kw)
        assert tz_utils.today_date_str() == "2026-01-01"


def test_yesterday_date_str_is_one_day_before_today():
    """Regardless of exact time, yesterday should be one calendar day before today."""
    today = tz_utils.today_date_str()
    yesterday = tz_utils.yesterday_date_str()
    # Simple check: they're different strings
    assert today != yesterday
    # Parse and compare
    from datetime import date
    t = date.fromisoformat(today)
    y = date.fromisoformat(yesterday)
    assert (t - y).days == 1
```

- [ ] **Step 2: Write `pipeline/tz_utils.py`**

```python
"""Poland-timezone date helpers. Mirrors workers/cron/src/index.ts todayDateStr().

Cron fires on UTC schedule but we compute dates in Europe/Warsaw so per-day
aggregates line up with the rest of the Polish rail system.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

WARSAW = ZoneInfo("Europe/Warsaw")


def today_date_str() -> str:
    """Return today's date in Warsaw timezone as YYYY-MM-DD."""
    return datetime.now(timezone.utc).astimezone(WARSAW).date().isoformat()


def yesterday_date_str() -> str:
    """Return yesterday's date in Warsaw timezone as YYYY-MM-DD."""
    warsaw_now = datetime.now(timezone.utc).astimezone(WARSAW)
    return (warsaw_now - timedelta(days=1)).date().isoformat()
```

- [ ] **Step 3: Run the tests**

```bash
cd pipeline && python3 -m pytest test_tz_utils.py -v
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add pipeline/tz_utils.py pipeline/test_tz_utils.py
git commit -m "feat(pipeline): add tz_utils with Poland-tz parity test"
```

---

### Task 12: Build cf_d1.py (D1 REST helper)

**Files:**
- Create: `pipeline/cf_d1.py`

- [ ] **Step 1: Write `pipeline/cf_d1.py`**

```python
"""Cloudflare D1 REST API client.

Wraps the D1 HTTP API so Modal functions can read/write the same database
the Astro worker uses natively. Supports single queries and batched
statement arrays in one POST.

Env vars (from modal Secret 'niejedzie-cloudflare'):
  CF_API_TOKEN      — API token with D1:Edit scope
  CF_ACCOUNT_ID     — Cloudflare account id
  D1_DATABASE_ID    — D1 database uuid
"""
from __future__ import annotations

import os
import time
from typing import Any

import requests

_BASE_TIMEOUT = 60.0
_MAX_ATTEMPTS = 3


def _env() -> tuple[str, str, str]:
    token = os.environ["CF_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    db_id = os.environ["D1_DATABASE_ID"]
    return token, account, db_id


def _endpoint() -> str:
    _, account, db_id = _env()
    return (
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/d1/database/{db_id}/query"
    )


def _headers() -> dict[str, str]:
    token, _, _ = _env()
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def query(sql: str, params: list[Any] | None = None) -> list[dict]:
    """Execute a single SQL statement. Returns `results` list (rows as dicts).

    Raises RuntimeError on API failure. Retries on 5xx / 429.
    """
    body = {"sql": sql, "params": params or []}
    return _post_with_retry(body)[0]["results"]


def batch(statements: list[tuple[str, list[Any]]]) -> list[dict]:
    """Execute multiple SQL statements in one round-trip. Each statement is
    (sql, params). D1 HTTP API supports this natively — one POST, N results.

    Returns a list of `{meta, results, success}` dicts in the same order.
    """
    body = [{"sql": sql, "params": params} for sql, params in statements]
    return _post_with_retry(body)


def _post_with_retry(body) -> list[dict]:
    url = _endpoint()
    headers = _headers()
    last_err: str | None = None

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=_BASE_TIMEOUT)
            if r.ok:
                payload = r.json()
                if not payload.get("success"):
                    raise RuntimeError(
                        f"D1 query reported failure: {payload.get('errors')}"
                    )
                return payload["result"]
            # Retry 5xx and 429; give up on other 4xx
            if r.status_code in (429,) or 500 <= r.status_code < 600:
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(0.5 * attempt)
                    continue
            raise RuntimeError(
                f"D1 query failed HTTP {r.status_code}: {r.text[:500]}"
            )
        except requests.RequestException as e:
            last_err = str(e)
            if attempt < _MAX_ATTEMPTS:
                time.sleep(0.5 * attempt)
                continue
            raise RuntimeError(f"D1 network error: {last_err}") from e
    raise RuntimeError(f"D1 exhausted retries: {last_err}")
```

- [ ] **Step 2: Smoke-test locally with real credentials (optional at this stage — will be tested in Task 16 via `modal run`)**

- [ ] **Step 3: Commit**

```bash
git add pipeline/cf_d1.py
git commit -m "feat(pipeline): add cf_d1 D1 REST client with batch support"
```

---

### Task 13: Build cf_kv.py (KV REST helper)

**Files:**
- Create: `pipeline/cf_kv.py`

- [ ] **Step 1: Write `pipeline/cf_kv.py`**

```python
"""Cloudflare Workers KV REST API client.

Env vars (from 'niejedzie-cloudflare' secret):
  CF_API_TOKEN, CF_ACCOUNT_ID, KV_NAMESPACE_ID
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests


def _endpoint(key: str) -> str:
    account = os.environ["CF_ACCOUNT_ID"]
    ns = os.environ["KV_NAMESPACE_ID"]
    return (
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/storage/kv/namespaces/{ns}/values/{key}"
    )


def _headers(content_type: str = "application/json") -> dict[str, str]:
    token = os.environ["CF_API_TOKEN"]
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
    }


def put(key: str, value: Any, expiration_ttl: int | None = None) -> None:
    """Write a JSON-serializable value to KV under `key`.

    The worker frontend reads this with `get(key, 'json')` so we must store
    a JSON string (not the raw object). Matches the current TS worker's
    `env.DELAYS_KV.put(key, JSON.stringify(obj), {expirationTtl})` behavior.
    """
    url = _endpoint(key)
    if expiration_ttl is not None:
        url = f"{url}?expiration_ttl={expiration_ttl}"
    body = json.dumps(value) if not isinstance(value, (str, bytes)) else value
    r = requests.put(url, headers=_headers("text/plain"), data=body, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if not payload.get("success"):
        raise RuntimeError(f"KV put failed: {payload.get('errors')}")


def get(key: str) -> Any | None:
    """Read and JSON-decode a KV value. Returns None if the key doesn't exist."""
    url = _endpoint(key)
    r = requests.get(url, headers=_headers(), timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()
```

- [ ] **Step 2: Commit**

```bash
git add pipeline/cf_kv.py
git commit -m "feat(pipeline): add cf_kv KV REST client"
```

---

### Task 14: Port sync_schedules.py

**Files:**
- Create: `pipeline/sync_schedules.py`

Reference source: `workers/cron/src/index.ts` function `syncSchedulesForDate` (around line 502).

- [ ] **Step 1: Read the TS reference**

```bash
sed -n '502,580p' workers/cron/src/index.ts
```

- [ ] **Step 2: Write `pipeline/sync_schedules.py`**

```python
"""Port of workers/cron/src/index.ts:syncSchedulesForDate.

Fetches /api/v1/schedules for a given date, populates D1 `trains` and
`train_routes`, and refreshes the `stations` dictionary. Uses INSERT OR
REPLACE on natural keys so repeated runs are idempotent.
"""
from __future__ import annotations

import os

import cf_d1
import pkp_api

D1_BATCH_MAX = 25  # D1 REST caps per-batch requests; keep under the limit


def sync_schedules_for_date(date: str) -> int:
    """Pull /schedules for one date, upsert into trains + train_routes + stations.

    Returns the total route count processed.
    """
    pkp_key = os.environ["PKP_API_KEY"]
    print(f"[sync_schedules] syncing {date}")

    pending_train_stmts: list[tuple[str, list]] = []
    pending_route_stmts: list[tuple[str, list]] = []

    def on_page(routes: list[dict], stations: dict[str, str], page_num: int) -> None:
        for route in routes:
            train_number = pkp_api.extract_train_number(route)
            carrier = route.get("carrierCode") or ""
            category = route.get("commercialCategorySymbol") or ""
            route_stations = route.get("stations") or []
            first_station = route_stations[0] if route_stations else None
            last_station = route_stations[-1] if route_stations else None
            route_start = (
                stations.get(str(first_station["stationId"]), "") if first_station else ""
            )
            route_end = (
                stations.get(str(last_station["stationId"]), "") if last_station else ""
            )

            pending_train_stmts.append(
                (
                    """INSERT OR REPLACE INTO trains
                       (schedule_id, order_id, train_number, carrier, category,
                        route_start, route_end, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                    [
                        route["scheduleId"],
                        route["orderId"],
                        train_number,
                        carrier,
                        category,
                        route_start,
                        route_end,
                    ],
                )
            )

            trip_id = f"{route['scheduleId']}-{route['orderId']}"
            for st in route_stations:
                pending_route_stmts.append(
                    (
                        """INSERT OR REPLACE INTO train_routes
                           (operating_date, train_number, stop_sequence, stop_id,
                            arrival_time, departure_time, trip_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        [
                            date,
                            train_number,
                            st.get("orderNumber"),
                            st["stationId"],
                            st.get("arrivalTime"),
                            st.get("departureTime"),
                            trip_id,
                        ],
                    )
                )

        # Flush in chunks to respect D1 batch cap
        _flush(pending_train_stmts)
        _flush(pending_route_stmts)
        print(f"[sync_schedules] {date} page {page_num} — {len(routes)} routes")

    result = pkp_api.fetch_schedules_pages(pkp_key, date, on_page)

    # Update stations dictionary
    station_stmts: list[tuple[str, list]] = []
    for sid_str, name in result["stations"].items():
        try:
            sid = int(sid_str)
        except ValueError:
            continue
        city = name.split(" ")[0] if name else name
        station_stmts.append(
            (
                "INSERT OR REPLACE INTO stations (station_id, name, city) VALUES (?, ?, ?)",
                [sid, name, city],
            )
        )
    _flush(station_stmts)

    return result["total_routes"]


def _flush(statements: list[tuple[str, list]]) -> None:
    """Send pending statements in D1_BATCH_MAX-sized chunks, then clear the list."""
    while statements:
        chunk, statements[:] = statements[:D1_BATCH_MAX], statements[D1_BATCH_MAX:]
        cf_d1.batch(chunk)
```

- [ ] **Step 3: Commit**

```bash
git add pipeline/sync_schedules.py
git commit -m "feat(pipeline): port sync_schedules with batched D1 writes"
```

---

### Task 15: Port poll_operations.py

**Files:**
- Create: `pipeline/poll_operations.py`

Reference source: `workers/cron/src/index.ts` function `pollOperations` (around line 123–495).

- [ ] **Step 1: Read the TS reference**

```bash
sed -n '123,500p' workers/cron/src/index.ts
```

- [ ] **Step 2: Write `pipeline/poll_operations.py`**

Given the original is ~380 lines, the port will be similar in size. Build it as a single function `poll_operations()` matching the TS structure:

1. Load `train_meta` from D1 `trains` table into a dict keyed `f"{schedule_id}-{order_id}"`.
2. Start a stats fetch request in the background (just call synchronously — Modal handles concurrency differently).
3. Stream `/api/v1/operations` pages via `pkp_api.fetch_operations_pages` with an `on_page` handler that:
   - For each train: compute delay stats, build delay_snapshots rows, build active_trains rows.
   - Batch-write to D1 via `cf_d1.batch`.
   - Skip trains with `trainStatus == 'S'`.
   - Apply `extract_train_number` fallback with compound placeholder.
4. After all pages processed: compute punctuality, avg delay, topDelayed[:10].
5. Compute hourly delays from delay_snapshots (GROUP BY strftime('%H:00', ...)).
6. Compute daily punctuality from D1 aggregation.
7. Write `stats:today` KV via `cf_kv.put(..., expiration_ttl=600)`.
8. Write `operations:latest` KV.

Key types/structures to preserve:
- `train_meta` dict: `{trainKey: {train_number, carrier, category, route_start, route_end}}`
- `top_delayed_candidates` list of dicts with `{trainNumber, delay, route, station, carrier}`
- `todayStats` KV payload with identical shape to the current TS `env.DELAYS_KV.put("stats:today", ...)` — frontend's `/api/delays/today` reads this exact shape so fields must match character-for-character.

Because this is a 200-300-line port, I'm not inlining it verbatim — follow the TS source exactly, function-by-function. The key discipline is: **every KV field name and every D1 column list must match the TS worker byte-for-byte** so the Astro frontend doesn't need any changes.

Key reference points from the TS source:
- Line 129: `SELECT schedule_id, order_id, train_number, carrier, category, route_start, route_end FROM trains` → `cf_d1.query(...)` loading `train_meta`.
- Line 174–187: INSERT statements — copy the column lists verbatim.
- Line 198–327: streaming page loop — each train's station loop, delay computation, active_trains construction.
- Line 335–344: final stats computation (avgDelay, punctualityPct).
- Line 342–367: first KV write (basic) with `expirationTtl: 600`.
- Line 438–467: final KV write with hourly + disruptions merged in.
- Line 476–483: `operations:latest` KV write.

- [ ] **Step 3: Commit**

```bash
git add pipeline/poll_operations.py
git commit -m "feat(pipeline): port poll_operations with byte-compatible KV payload"
```

---

### Task 16: Port poll_disruptions.py + aggregate_daily.py

**Files:**
- Create: `pipeline/poll_disruptions.py`
- Create: `pipeline/aggregate_daily.py`

Reference sources:
- `workers/cron/src/index.ts` function `pollDisruptions` (around lines 580–650)
- `workers/cron/src/index.ts` function `aggregateDaily` + `backfillCityDaily` (around lines 700–1100)

- [ ] **Step 1: Write `pipeline/poll_disruptions.py`**

Match the TS logic:
1. `pkp_api.fetch_disruptions(pkp_key)` → list of disruption dicts.
2. For each: `INSERT OR REPLACE INTO disruptions (...)`.
3. Mark `is_active = 0` for any disruption IDs not in the current fetch (so stale ones disappear).
4. Write `disruptions:active` KV with the current list, `expiration_ttl=600`.

- [ ] **Step 2: Write `pipeline/aggregate_daily.py`**

Match the TS logic:
1. Compute daily_stats from `delay_snapshots` grouped by operating_date — matches the TS aggregateDaily SQL.
2. Compute city_daily JOIN stations on city, per-date per-city aggregates.
3. Prune `delay_snapshots` older than 30 days, `active_trains` older than 7 days, `train_routes` older than 7 days — matches the TS prune section.

- [ ] **Step 3: Commit**

```bash
git add pipeline/poll_disruptions.py pipeline/aggregate_daily.py
git commit -m "feat(pipeline): port poll_disruptions and aggregate_daily"
```

---

### Task 17: Wire modal_cron.py with schedules

**Files:**
- Create: `pipeline/modal_cron.py`

- [ ] **Step 1: Write `pipeline/modal_cron.py`**

```python
"""Modal app for niejedzie.pl scheduled jobs.

Replaces the Cloudflare cron worker. Three scheduled functions:
- poll_operations  — every 5 min — PKP API → delay_snapshots + stats:today KV
- poll_disruptions — every 5 min — PKP API → disruptions + disruptions:active KV
- sync_daily       — daily 02:00 UTC — /schedules for today+yesterday + aggregate + prune

Deploy:
    modal deploy modal_cron.py

Manual trigger:
    modal run modal_cron.py::poll_operations
"""
import modal

app = modal.App("niejedzie-cron")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("requests>=2.31", "python-dateutil>=2.8")
    .add_local_file("pkp_api.py", "/root/pkp_api.py")
    .add_local_file("cf_d1.py", "/root/cf_d1.py")
    .add_local_file("cf_kv.py", "/root/cf_kv.py")
    .add_local_file("tz_utils.py", "/root/tz_utils.py")
    .add_local_file("sync_schedules.py", "/root/sync_schedules.py")
    .add_local_file("poll_operations.py", "/root/poll_operations.py")
    .add_local_file("poll_disruptions.py", "/root/poll_disruptions.py")
    .add_local_file("aggregate_daily.py", "/root/aggregate_daily.py")
)

SECRETS = [
    modal.Secret.from_name("niejedzie-cloudflare"),
    modal.Secret.from_name("niejedzie-pkp"),
]

RETRIES = modal.Retries(
    max_retries=2,
    backoff_coefficient=2.0,
    initial_delay=10.0,
)


@app.function(
    image=image,
    secrets=SECRETS,
    schedule=modal.Cron("*/5 * * * *"),
    timeout=300,
    retries=RETRIES,
)
def poll_operations():
    import poll_operations as impl
    impl.poll_operations()


@app.function(
    image=image,
    secrets=SECRETS,
    schedule=modal.Cron("*/5 * * * *"),
    timeout=60,
    retries=RETRIES,
)
def poll_disruptions():
    import poll_disruptions as impl
    impl.poll_disruptions()


@app.function(
    image=image,
    secrets=SECRETS,
    schedule=modal.Cron("0 2 * * *"),
    timeout=900,
    retries=modal.Retries(max_retries=1, initial_delay=60.0),
)
def sync_daily():
    import sync_schedules
    import aggregate_daily
    import tz_utils

    today = tz_utils.today_date_str()
    yesterday = tz_utils.yesterday_date_str()

    print(f"[sync_daily] syncing today {today}")
    today_routes = sync_schedules.sync_schedules_for_date(today)

    print(f"[sync_daily] syncing yesterday {yesterday}")
    yesterday_routes = sync_schedules.sync_schedules_for_date(yesterday)

    print(f"[sync_daily] synced {today_routes} today + {yesterday_routes} yesterday routes")

    aggregate_daily.aggregate_daily()
    aggregate_daily.backfill_city_daily()
    aggregate_daily.prune_old_data()
```

- [ ] **Step 2: Commit** (don't deploy yet)

```bash
git add pipeline/modal_cron.py
git commit -m "feat(pipeline): wire modal_cron with schedules (not yet deployed)"
```

---

### Task 18: Create Modal secrets (YOU do this step manually)

**No file changes — Modal CLI only.**

- [ ] **Step 1: Create a Cloudflare API token**

Visit https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token.

Permissions:
- `Account` / `D1` / `Edit`
- `Account` / `Workers KV Storage` / `Edit`

Account resources: Include → Specific account → (your account `cdffba3e7552f7f10e24305cdce5aa94`)

Create, copy the token. This is a secret — paste only into Modal, don't commit.

- [ ] **Step 2: Get the PKP API key from the existing Cloudflare worker secret binding**

```bash
npx wrangler secret list --name niejedzie-cron
```

You'll see it in the list but the value is encrypted. You should have the key on hand from when it was first set up (email from `pdp-api@plk-sa.pl`). If not, request a new one and update both places.

- [ ] **Step 3: Create both Modal secrets**

```bash
modal secret create niejedzie-cloudflare \
  CF_API_TOKEN="paste-new-cf-token-here" \
  CF_ACCOUNT_ID="cdffba3e7552f7f10e24305cdce5aa94" \
  D1_DATABASE_ID="daf01417-76ef-4663-a383-20d2dbb251e3" \
  KV_NAMESPACE_ID="9ed4ec652775490e8e1c3e73e92e4208"

modal secret create niejedzie-pkp \
  PKP_API_KEY="paste-pkp-key-here"
```

- [ ] **Step 4: Verify they appear**

```bash
modal secret list | grep niejedzie
```

Expected: both names listed.

---

### Task 19: Deploy Modal, run each function manually, verify writes

**Files:** none (deployment + verification)

- [ ] **Step 1: Deploy**

```bash
cd pipeline
modal deploy modal_cron.py 2>&1 | tail -20
```

Expected: `✓ App deployed in N seconds!` with three functions listed.

- [ ] **Step 2: Run `poll_disruptions` first (smallest, simplest — verifies auth works)**

```bash
modal run modal_cron.py::poll_disruptions 2>&1 | tail -20
```

Expected: exits cleanly. Check D1 to confirm writes:

```bash
cd ..
npx wrangler d1 execute niejedzie-db --remote --command "SELECT COUNT(*) FROM disruptions WHERE is_active=1"
```

Expected: some count (often 0–5 active disruptions).

Also check KV:

```bash
npx wrangler kv key get --binding DELAYS_KV --remote disruptions:active | head -c 500
```

Expected: a JSON blob with `{"disruptions": [...]}`.

- [ ] **Step 3: Run `poll_operations` manually**

```bash
cd pipeline
modal run modal_cron.py::poll_operations 2>&1 | tail -30
```

Expected: 1-3 minutes of output showing pages processed, eventually `[pollOperations] Stats — trains: N, onTime: M, ...` style line.

Verify D1 rows landed:

```bash
cd ..
npx wrangler d1 execute niejedzie-db --remote --command "SELECT COUNT(*) FROM delay_snapshots WHERE operating_date = date('now', 'localtime')"
```

Expected: a non-zero number (matching the trains-today count).

Verify KV:

```bash
npx wrangler kv key get --binding DELAYS_KV --remote stats:today | head -c 800
```

Expected: a JSON blob with `timestamp`, `totalTrains`, `punctualityPct`, `topDelayed`, etc.

- [ ] **Step 4: Run `sync_daily` manually (takes 3-8 min with retries)**

```bash
cd pipeline
modal run modal_cron.py::sync_daily 2>&1 | tail -30
```

Expected: `[sync_daily] synced ~5500 today + ~5500 yesterday routes`.

Verify:

```bash
cd ..
npx wrangler d1 execute niejedzie-db --remote --command "SELECT COUNT(*) FROM trains"
```

Expected: ~5,500 (matches today's full PKP schedule).

- [ ] **Step 5: Commit deployment record**

```bash
# No code change — just a note
git commit --allow-empty -m "ops: modal niejedzie-cron deployed and smoke-tested

poll_operations, poll_disruptions, sync_daily all ran manually
and wrote to D1/KV successfully. Schedules are not yet active —
they will fire automatically once Task 20 confirms dry-run parity."
```

---

### Task 20: Dry-run parity comparison between Modal and Cloudflare cron

**Files:** none (verification only)

- [ ] **Step 1: Force a fresh write from both, 1 minute apart**

```bash
# Trigger Cloudflare cron synchronously
curl -s "https://niejedzie-cron.maciej-janowski1.workers.dev/__trigger/operations-sync" 2>&1 | head -c 200

# Note the timestamp
date -u +"%H:%M:%S"

# Read stats:today
npx wrangler kv key get --binding DELAYS_KV --remote stats:today > /tmp/cf-stats.json
```

Wait at least 30 seconds, then:

```bash
cd pipeline
modal run modal_cron.py::poll_operations 2>&1 | tail -5
cd ..
npx wrangler kv key get --binding DELAYS_KV --remote stats:today > /tmp/modal-stats.json
```

- [ ] **Step 2: Diff the two JSON blobs**

```bash
diff <(python3 -c "import json; d=json.load(open('/tmp/cf-stats.json')); print(sorted(d.keys())); print('totalTrains:', d.get('totalTrains')); print('punctualityPct:', d.get('punctualityPct'))") <(python3 -c "import json; d=json.load(open('/tmp/modal-stats.json')); print(sorted(d.keys())); print('totalTrains:', d.get('totalTrains')); print('punctualityPct:', d.get('punctualityPct'))")
```

Expected: either **no diff** or very small differences (a few trains may have moved between the two runs). If fields are missing or present on only one side, that's a port bug — go back and fix.

- [ ] **Step 3: Check a few specific fields match**

```bash
for key in totalTrains punctualityPct avgDelay cancelledCount onTimeCount; do
  cf=$(python3 -c "import json; print(json.load(open('/tmp/cf-stats.json')).get('$key'))")
  md=$(python3 -c "import json; print(json.load(open('/tmp/modal-stats.json')).get('$key'))")
  echo "$key: cf=$cf modal=$md"
done
```

Expected: same or very close values.

- [ ] **Step 4: Check topDelayed has the same shape**

```bash
for f in /tmp/cf-stats.json /tmp/modal-stats.json; do
  echo "--- $f ---"
  python3 -c "import json; d=json.load(open('$f')); print(list(d['topDelayed'][0].keys()) if d.get('topDelayed') else 'empty')"
done
```

Expected: both sides show `['trainNumber', 'delay', 'route', 'station', 'carrier']`.

- [ ] **Step 5: If any mismatch, fix and redeploy. If all match, proceed.**

---

### Task 21: Cut over — disable Cloudflare cron

**Files:**
- Modify: `workers/cron/wrangler.jsonc`

- [ ] **Step 1: Remove the `triggers` section**

Edit `workers/cron/wrangler.jsonc`:

```jsonc
{
  "name": "niejedzie-cron",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-17",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "niejedzie-db",
      "database_id": "daf01417-76ef-4663-a383-20d2dbb251e3"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "DELAYS_KV",
      "id": "9ed4ec652775490e8e1c3e73e92e4208"
    }
  ]
  // triggers removed — Modal niejedzie-cron now handles scheduling.
  // The worker stays alive for /__trigger/* debug endpoints only.
}
```

- [ ] **Step 2: Redeploy the cron worker with triggers removed**

```bash
cd workers/cron
npx wrangler deploy 2>&1 | tail -10
```

Expected: deploy succeeds. The output should NOT show any schedule line (previously it showed `schedule: */5 * * * *` and `schedule: 0 2 * * *`).

- [ ] **Step 3: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
git add workers/cron/wrangler.jsonc
git commit -m "ops: disable Cloudflare cron triggers — Modal niejedzie-cron now owns scheduling

Worker stays alive for /__trigger/* debug endpoints. Rollback path:
re-add triggers section and wrangler deploy (~30 sec)."
git push
```

---

### Task 22: Monitor for 1 hour, then mark cutover done

**Files:** none (observation only)

- [ ] **Step 1: Baseline — note current D1 state**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "SELECT COUNT(*) as snaps FROM delay_snapshots WHERE operating_date=date('now', 'localtime')"
npx wrangler kv key get --binding DELAYS_KV --remote stats:today | python3 -c "import sys,json; d=json.load(sys.stdin); print('timestamp:', d.get('timestamp'))"
```

Record both values + the time.

- [ ] **Step 2: Wait 10-15 minutes, then poll again**

```bash
# After 10-15 min:
npx wrangler kv key get --binding DELAYS_KV --remote stats:today | python3 -c "import sys,json; d=json.load(sys.stdin); print('timestamp:', d.get('timestamp'))"
```

Expected: timestamp is newer than baseline (Modal has been writing every 5 min).

- [ ] **Step 3: Check Modal dashboard logs**

```bash
modal app logs niejedzie-cron 2>&1 | tail -30
```

Expected: 3+ successful `poll_operations` + `poll_disruptions` invocations in the log window. No error stacks.

- [ ] **Step 4: Hit /api/health on the site**

```bash
curl -s https://niejedzie.pl/api/health
```

Expected: `{"status":"healthy","dataAge":<6,...}`.

- [ ] **Step 5: If anything fails during this hour — roll back**

```bash
# Restore Cloudflare cron (undo Task 21)
cd workers/cron
# Edit wrangler.jsonc to add triggers back:
#   "triggers": { "crons": ["*/5 * * * *", "0 2 * * *"] }
npx wrangler deploy

# Pause Modal
modal app stop niejedzie-cron
```

Report back with logs for debugging.

- [ ] **Step 6: If all green, commit cutover record**

```bash
git commit --allow-empty -m "ops: modal cutover complete — 1 hour stable

All Modal functions firing on schedule, D1 writes advancing, KV freshness
within 5 min, /api/health returns healthy. Cloudflare cron triggers stay
disabled. Rollback path documented in commit f4ae247 body."
git push
```

---

## Phase 4 — Push notification e2e verification (~1 hour)

### Task 23: Read current push infrastructure

**Files:** none (investigation)

- [ ] **Step 1: Read the push subscribe endpoint**

```bash
cat src/pages/api/push/subscribe.ts 2>/dev/null | head -80
# Or find it
find src/pages/api/push -type f
```

Note: (a) what it writes to D1, (b) which table, (c) what response.

- [ ] **Step 2: Read the Stripe webhook that links payment → monitoring session**

```bash
cat src/pages/api/webhooks/stripe.ts | head -100
```

Note: does the webhook create a monitoring_session with status='active' on checkout.session.completed?

- [ ] **Step 3: Find the web-push send call**

```bash
grep -rn "web-push\|webpush\|sendNotification\|VAPID" src workers/cron/src 2>/dev/null
```

Note: which file sends pushes, what library, which env variable provides the private key.

- [ ] **Step 4: Check the monitoring_sessions schema**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "SELECT sql FROM sqlite_master WHERE name='monitoring_sessions'"
```

Note: columns, required fields, status enum values.

- [ ] **Step 5: Write findings to a scratch note for the next task**

```bash
cat > /tmp/push-audit.md << 'EOF'
## Push infrastructure audit

- Subscribe endpoint: <path>
- Writes to: monitoring_sessions with columns X, Y, Z
- Stripe webhook: creates session on checkout.session.completed YES/NO
- Web-push send call: <file:line>
- VAPID private key env: <var name>
- web-push library: <name> (JS package or custom?)
EOF
```

---

### Task 24: Synthetic subscribe test + verify DB row

**Files:** none (HTTP + D1 queries)

- [ ] **Step 1: Construct a synthetic PushSubscription JSON**

```bash
cat > /tmp/fake-sub.json << 'EOF'
{
  "endpoint": "https://httpbin.org/post",
  "expirationTime": null,
  "keys": {
    "p256dh": "BOL8tL_zKk-TRwUKV5kOYxwW8fYXxZ5H1nN-LZG6qJ6pXEJFxLdOCdFs5KG6_xQHQv9xUfvYCN5-jq8mHR0yOW8",
    "auth": "dvGtFcuZqvvgfT1gKz6MZQ"
  }
}
EOF
```

- [ ] **Step 2: POST it to /api/push/subscribe with a fake monitoring session id**

```bash
curl -sX POST https://niejedzie.pl/api/push/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-session-'$(date +%s)'","subscription":'"$(cat /tmp/fake-sub.json)"'}'
```

Expected: `{"success":true}` or equivalent success response. Exact shape depends on what Task 23 found.

- [ ] **Step 3: Verify D1 row landed**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "SELECT id, status, push_subscription FROM monitoring_sessions WHERE id LIKE 'test-session-%' ORDER BY id DESC LIMIT 1"
```

Expected: one row with the test session ID and a non-empty push_subscription JSON.

- [ ] **Step 4: Clean up test row**

```bash
npx wrangler d1 execute niejedzie-db --remote --command "DELETE FROM monitoring_sessions WHERE id LIKE 'test-session-%'"
```

- [ ] **Step 5: Document the result — pass/fail**

If step 3 returned a row, the subscribe endpoint + D1 write path is green. Note this for the final audit.

---

### Task 25: Add /__trigger/test-push endpoint + document client checklist

**Files:**
- Modify: `workers/cron/src/index.ts` (add debug endpoint)
- Create: `docs/superpowers/push-e2e-checklist.md`

- [ ] **Step 1: Add the test-push endpoint to the worker fetch handler**

Edit `workers/cron/src/index.ts`, find the fetch handler (around line 1438) that handles `/__trigger/*` paths, and add:

```typescript
if (url.pathname === "/__trigger/test-push") {
    try {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) {
            return Response.json({ error: "missing ?session=ID" }, { status: 400 });
        }
        const session = await env.DB.prepare(
            "SELECT id, push_subscription FROM monitoring_sessions WHERE id = ? AND status = 'active'"
        ).bind(sessionId).first();
        if (!session) {
            return Response.json({ error: "session not found or inactive" }, { status: 404 });
        }
        const subscription = JSON.parse(session.push_subscription as string);

        // Build a minimal push payload
        const payload = JSON.stringify({
            title: "niejedzie.pl — test push",
            body: `Synthetic test push for session ${sessionId}`,
            url: "/sukces",
        });

        // Call the same push-send helper the cron uses for real alerts.
        // (Replace this import/call with whatever Task 23 identified as the
        //  push-send function — e.g., `sendWebPush(subscription, payload, env)`.)
        const result = await sendWebPush(subscription, payload, env);
        return Response.json({ sent: true, result });
    } catch (err) {
        return Response.json({ error: String(err), stack: (err as Error).stack }, { status: 500 });
    }
}
```

If Task 23 discovered the push send function doesn't yet exist as a reusable helper, extract it from wherever it lives into a shared module first — otherwise this endpoint has nothing to call.

- [ ] **Step 2: Deploy the cron worker (it still serves debug endpoints even with Modal handling crons)**

```bash
cd workers/cron
npx wrangler deploy 2>&1 | tail -5
```

- [ ] **Step 3: Write the client-side checklist doc**

Create `docs/superpowers/push-e2e-checklist.md`:

```markdown
# niejedzie push notification — end-to-end client-side test

**When to run:** after the server-side verification in Task 24 passes. Takes ~5 min.

**You'll need:** a phone with Chrome (Android) or Safari (iOS) + your own Stripe-compatible card.

## Steps

1. **On your phone (iOS only — Android skips this step):** open Safari → go to `https://niejedzie.pl` → tap the share button → "Add to Home Screen". Then open the new home-screen icon. iOS requires installing the site as a PWA before web push works.

2. **On the homepage:** enter a train number you know exists (e.g., `IC 5313`) and a destination (e.g., `Warszawa Centralna`). Tap "Sprawdź połączenie".

3. **On the `/wynik` page:** tap the blue button "Monitoruj przesiadkę — 5 zł". Stripe Checkout opens.

4. **In Stripe Checkout:** pay with your own card (live mode — you can refund yourself after from the Stripe dashboard → Payments → Refund).

5. **On the `/sukces` page after successful payment:** you'll be prompted to grant notification permission. Tap **Allow**. Note the session ID shown on the page (or from the URL).

6. **From any device** (laptop is fine), hit the test endpoint with your session ID:
   ```
   https://niejedzie-cron.maciej-janowski1.workers.dev/__trigger/test-push?session=<your-session-id>
   ```
   The response should be `{"sent": true, ...}`.

7. **On your phone:** a push notification titled "niejedzie.pl — test push" should arrive within ~10 seconds.

## What to report back

- **If step 7 works** → push is e2e validated. Report: `PASS` + session ID.
- **If no push arrives** → report the exact step where things broke:
  - No Stripe checkout opening? (Task 25 server-side issue.)
  - Notification permission prompt never appeared? (Service worker registration bug.)
  - Push endpoint returned error? (Include response body.)
  - Endpoint returned success but no push? (VAPID signature or web-push send bug — I'll investigate.)

## Refunding your test payment

Stripe dashboard → Payments → find the 5 zł test charge → Refund. Takes a few seconds.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
git add workers/cron/src/index.ts docs/superpowers/push-e2e-checklist.md
git commit -m "feat: add /__trigger/test-push endpoint + client-side e2e checklist"
git push
```

---

## Phase 5 — Verification audit + cleanup (30 min)

### Task 26: Update niejedzie CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (parent pkp-delay-tracker repo, not niejedzie)

- [ ] **Step 1: Open and find the Backend Architecture + Commands sections**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
grep -n "Cron Worker\|npx wrangler deploy\|cron worker\|triggers" CLAUDE.md | head
```

- [ ] **Step 2: Rewrite the "Backend Architecture" subsection**

Replace the existing "Cron Worker" block with:

```markdown
### Scheduling (Modal)

Three Python scheduled functions on Modal app `niejedzie-cron` at
`projects/pkp-delay-tracker/niejedzie/pipeline/`:

```
poll_operations   */5 * * * *  (every 5 min)
  1. Fetch /api/v1/operations + /operations/statistics
  2. Stream pages → D1 delay_snapshots + active_trains
  3. Compute stats, topDelayed, hourlyDelays
  4. Write stats:today KV (ttl 600)
  5. Write operations:latest KV

poll_disruptions  */5 * * * *  (every 5 min)
  Fetch /api/v1/disruptions → D1 disruptions + disruptions:active KV

sync_daily        0 2 * * *    (02:00 UTC)
  syncSchedulesForDate(today) + syncSchedulesForDate(yesterday)
  aggregate_daily → daily_stats
  backfill_city_daily → city_daily
  prune: delay_snapshots > 30 days, active_trains/train_routes > 7 days
```

Modal secrets: `niejedzie-cloudflare` (CF_API_TOKEN, CF_ACCOUNT_ID,
D1_DATABASE_ID, KV_NAMESPACE_ID), `niejedzie-pkp` (PKP_API_KEY).

D1 and KV writes go through the Cloudflare REST APIs (`cf_d1.py`, `cf_kv.py`).
Astro frontend worker still uses native D1/KV bindings.

### Debug worker (Cloudflare)

The old `niejedzie-cron` Cloudflare Worker stays deployed at
`workers/cron/` but **has no schedule triggers** — Modal owns that now.
The worker exists only to serve `/__trigger/*` HTTP endpoints for manual
debugging (`debug-poll`, `test-push`, etc.).
```

- [ ] **Step 3: Rewrite the "Commands" subsection**

Replace the cron deploy command block with:

```markdown
# Deploy Modal pipeline
cd projects/pkp-delay-tracker/niejedzie/pipeline
modal deploy modal_cron.py

# Manual Modal runs
modal run modal_cron.py::poll_operations
modal run modal_cron.py::poll_disruptions
modal run modal_cron.py::sync_daily

# Modal logs
modal app logs niejedzie-cron

# Deploy debug worker (rare)
cd projects/pkp-delay-tracker/niejedzie/workers/cron && npx wrangler deploy
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update pkp-delay-tracker CLAUDE.md for Modal scheduling"
```

---

### Task 27: Fix stale "5 cron cap" note in checkpeptides CLAUDE.md

**Files:**
- Modify: `../checkpeptides/CLAUDE.md`

- [ ] **Step 1: Find the note**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/checkpeptides
grep -n "5 cron\|cron jobs\|Modal free tier capped" CLAUDE.md
```

- [ ] **Step 2: Replace the stale note**

Find the line that reads something like "Not scheduled — Modal free tier capped at 5 cron jobs" and replace with the actual reason the function isn't scheduled (probably "Run manually; doesn't need recurring schedule" or similar).

If the line specifically says the cap is 5 cron jobs, replace with:

```
Not scheduled — run manually or wire a GitHub Actions cron when needed. Modal
Starter plan has no specific cron-count limit; the $30/month credit is the
real constraint and we're well under it.
```

- [ ] **Step 3: Commit in the checkpeptides repo**

```bash
git add CLAUDE.md
git commit -m "docs: remove stale '5 cron cap' note — Modal has no such limit"
```

---

### Task 28: Re-run the browser verification audit

**Files:** none (verification via claude-in-chrome browser tools)

- [ ] **Step 1: Open a Chrome tab via the MCP tool**

```
mcp__claude-in-chrome__tabs_context_mcp with createIfEmpty=true
```

- [ ] **Step 2: Run the full audit checklist from spec §3.5, checking each item**

For each URL, use `mcp__claude-in-chrome__navigate` + `mcp__claude-in-chrome__read_page` (filter all) and verify the success criteria:

- [ ] `https://niejedzie.pl/` — live example card for train 80436 shows a real carrier, not "Nieznany przewoźnik"
- [ ] `https://niejedzie.pl/opoznienia/dzisiaj` — all top-delayed trains show real carrier codes (PR/IC/KD/PR/…)
- [ ] `https://niejedzie.pl/opoznienia/dzisiaj` — stats in the 85-92% punctuality / 2-6 min avg delay range
- [ ] `https://niejedzie.pl/gdzie-jest-pociag?q=60260` — delay growth chart renders, substring search works
- [ ] `https://niejedzie.pl/wynik?train=60260&destination=Wroc%C5%82aw+G%C5%82%C3%B3wny` — big arrival time shows `~14:50` (delayed), with "planowo 12:00 · +170 min" subline
- [ ] `https://niejedzie.pl/wynik?train=99999&destination=X` — three action links present
- [ ] `https://niejedzie.pl/cennik` — unchanged
- [ ] `https://niejedzie.pl/punktualnosc` — number not 44.5%, caption present if <7 rows
- [ ] `https://niejedzie.pl/opoznienia/warszawa` — avg delay < 10 min
- [ ] `https://niejedzie.pl/pociag/60260` — footer shows "Dane z PKP PLK Otwarte Dane Kolejowe"
- [ ] Modal: `modal app logs niejedzie-cron | tail -20` shows successful runs for the last hour
- [ ] KV: `stats:today` `timestamp` within last 10 min
- [ ] D1: `SELECT COUNT(*) FROM delay_snapshots` is stable, not climbing to millions
- [ ] Cloudflare: `npx wrangler deployments list niejedzie-cron` shows no schedule triggers
- [ ] Push: Task 24 result was PASS
- [ ] Push: client-side checklist handed to user

- [ ] **Step 3: Write the audit report**

Create `docs/superpowers/audit-2026-04-11-post-modal.md` with pass/fail for each item and any screenshots worth saving.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audit-2026-04-11-post-modal.md
git commit -m "docs: post-Modal audit report — all 15 items verified"
git push
```

---

### Task 29: Final push + celebrate

- [ ] **Step 1: Push everything**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
git push
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
# Parent pkp-delay-tracker repo is local-only per today's earlier check — commit only
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/checkpeptides
git push 2>&1 | tail -5
```

- [ ] **Step 2: Final state check**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker/niejedzie
git log --oneline -15
```

Expected: all the commits from Phases 1-5 present and pushed.

- [ ] **Step 3: Report back to user with a short summary of what shipped, what the audit showed, and the single remaining todo (client-side push checklist they run on their phone).**

---

## Rollback plan (if anything breaks mid-execution)

| Broken | Rollback command |
|---|---|
| Any small fix deploy | `git revert HEAD && git push && cd dist/server && npx wrangler deploy` |
| Modal cron misbehaving | Re-add `triggers` to `workers/cron/wrangler.jsonc`, `wrangler deploy`, then `modal app stop niejedzie-cron` |
| D1 row explosion again | Unique index still enforced — can't happen. If it does, `modal app stop niejedzie-cron` + investigate |
| City pages broken | Revert the commit that added `[city].astro` — the 8 hardcoded files are still in git history, restore them |

## Open questions / known unknowns

- **Modal secret create:** user runs Task 18 manually (token scopes + PKP API key handover). This is unavoidable — Modal secrets require CLI login as user.
- **Push client-side test:** only the user can run Task 25 step 4–7 (needs a phone + real 5 zł payment). Server-side pass in Task 24 is necessary but not sufficient.
- **stations.city coverage:** Task 6 decides if Task 7's `LIKE` pattern is enough or if a normalization pass is needed. If needed, add a one-off `UPDATE stations` step before Task 8.
- **poll_operations runtime:** if it ever exceeds 300s, bump the timeout or split into smaller chunks. Modal dashboard shows per-run duration.
