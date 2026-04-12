# niejedzie.pl v2 — Pure SaaS Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship niejedzie.pl v2 — a Next.js + SQLite + native-cron train transfer monitor on a Hetzner VPS, with Stripe payments and Web Push alerts, for €4.51/month flat cost.

**Architecture:** Hetzner CX22 VPS runs Node.js 22 with a Next.js app (SSR), a local SQLite database, native `cron`-driven pollers against the PKP PLK Open Data API, a Stripe Checkout flow, and direct Web Push notifications (VAPID-signed, no third-party push service). Cloudflare fronts the domain for DNS + free TLS + CDN. Zero managed-service billing except Stripe's per-transaction fee.

**Tech Stack:** Next.js 15 (App Router) · Node.js 22 · `better-sqlite3` · `stripe` SDK · `web-push` · Linux crontab · PM2 process manager · Tailwind CSS v4 · `hcloud` CLI · Cloudflare DNS API.

**Spec:** `docs/superpowers/specs/2026-04-12-niejedzie-v2-design.md`

This plan is split into two parts because it's long:
- **This file** — Phase 1 (infra) and Phase 2 (PKP API + cron scripts)
- `2026-04-12-niejedzie-v2-rebuild-part2.md` — Phase 3 (frontend), Phase 4 (payments + push), Phase 5 (deploy + verify)

---

## File Structure

All new code lives in a fresh directory `niejedzie-v2/` as sibling to the existing v1 `niejedzie/` directory. The v1 directory is kept read-only as reference for design tokens, copy, and PKP API behavior.

```
projects/pkp-delay-tracker/niejedzie-v2/
├── .env.example                        # Template — list all required env vars
├── .gitignore                          # node_modules, .next, *.db, .env
├── package.json                        # Next.js 15, better-sqlite3, stripe, web-push, zod
├── tsconfig.json
├── tsconfig.scripts.json               # Separate config for cron script compilation
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── ecosystem.config.js                 # PM2 config for prod
├── README.md                           # Deploy + env setup instructions
│
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # Root layout — fonts, Plausible, shared header/footer
│   │   ├── page.tsx                    # "/" homepage + connection checker form
│   │   ├── globals.css                 # Tailwind + v1 design tokens (cream/burnt-sienna)
│   │   ├── wynik/page.tsx              # "/wynik" connection check result (SSR)
│   │   ├── cennik/page.tsx             # "/cennik" pricing (static)
│   │   ├── sukces/page.tsx             # "/sukces" post-payment + push permission
│   │   ├── opoznienia/page.tsx         # "/opoznienia" delays dashboard
│   │   └── api/
│   │       ├── checkout/create/route.ts    # POST — create Stripe Checkout session
│   │       ├── webhooks/stripe/route.ts    # POST — Stripe webhook handler
│   │       ├── push/subscribe/route.ts     # POST — store push subscription
│   │       └── health/route.ts             # GET — server + DB health check
│   │
│   ├── components/
│   │   ├── ConnectionForm.tsx          # train# + destination inputs, submit → /wynik
│   │   └── TrainOperator.tsx           # Carrier badge, short-code aware
│   │
│   └── lib/
│       ├── db.ts                       # better-sqlite3 singleton + prepared stmts
│       ├── pkp-api.ts                  # PKP API client with retry + extractTrainNumber
│       ├── stripe.ts                   # Stripe SDK singleton
│       ├── webpush.ts                  # VAPID signing + push send helper
│       ├── time.ts                     # Warsaw-tz date helpers
│       └── constants.ts                # PRICES, TRAIN_OPERATORS, carrierToCode
│
├── scripts/
│   ├── poll-operations.ts              # Cron: every 5 min — PKP API → stats + active_trains
│   ├── sync-routes.ts                  # Cron: daily — /schedules → train_routes
│   ├── check-push.ts                   # Cron: every 1 min — fire pushes for delayed trains
│   ├── prune.ts                        # Cron: daily — delete old rows
│   └── migrate.ts                      # One-shot: create tables from schema.sql
│
├── db/
│   └── schema.sql                      # CREATE TABLE statements (4 tables from spec)
│
├── public/
│   ├── favicon.svg
│   └── sw.js                           # Service worker — listens for push events
│
├── tests/
│   ├── pkp-api.test.ts                 # extractTrainNumber + retry logic
│   └── time.test.ts                    # Warsaw-tz parity
│
└── infra/
    ├── provision.sh                    # hcloud CLI one-shot provisioning
    ├── bootstrap.sh                    # Server setup (ran once after provision)
    ├── nginx.conf                      # Reverse proxy config
    └── crontab.txt                     # 4 cron lines — installed on VPS
```

---

## Phase 1 — Scaffolding (~45 min)

### Task 1: Provision Hetzner VPS via `hcloud` CLI

**Files:**
- Create: `niejedzie-v2/infra/provision.sh`
- Modify: Cloudflare DNS for `niejedzie.pl`

- [ ] **Step 1: Install hcloud CLI locally if not present**

```bash
brew install hcloud
hcloud version
```

Expected: prints the CLI version.

- [ ] **Step 2: Create a Hetzner Cloud API token**

User visits https://console.hetzner.cloud/ → pick a project (or create "niejedzie") → Security → API Tokens → Generate API Token → Read & Write. Copy token.

- [ ] **Step 3: Configure hcloud CLI**

```bash
hcloud context create niejedzie
# Paste the API token when prompted
hcloud context list
```

Expected: `niejedzie` context listed as active.

- [ ] **Step 4: Upload SSH key**

```bash
hcloud ssh-key create --name maciej-laptop --public-key-file ~/.ssh/id_ed25519.pub
```

Expected: `SSH key N created`.

- [ ] **Step 5: Write `niejedzie-v2/infra/provision.sh`**

```bash
#!/usr/bin/env bash
# One-shot Hetzner VPS provisioning for niejedzie.pl v2.
# Idempotent — safe to re-run.
set -euo pipefail

NAME="niejedzie"
TYPE="cx22"
IMAGE="ubuntu-24.04"
LOCATION="fsn1"
SSH_KEY="maciej-laptop"

if ! hcloud server describe "$NAME" >/dev/null 2>&1; then
  hcloud server create --name "$NAME" --type "$TYPE" --image "$IMAGE" \
    --location "$LOCATION" --ssh-key "$SSH_KEY"
fi

IP=$(hcloud server ip "$NAME")
echo "Server ready at $IP"

if ! hcloud firewall describe "$NAME" >/dev/null 2>&1; then
  hcloud firewall create --name "$NAME" --rules-file <(cat <<'RULES'
[
  {"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"]},
  {"direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]},
  {"direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]}
]
RULES
  )
  hcloud firewall apply-to-resource "$NAME" --type server --server "$NAME"
fi

echo "SSH to the server: ssh root@$IP"
```

- [ ] **Step 6: Run provisioning**

```bash
chmod +x niejedzie-v2/infra/provision.sh
./niejedzie-v2/infra/provision.sh
```

Expected: `Server ready at X.X.X.X` with an IP.

- [ ] **Step 7: Verify SSH works**

```bash
ssh root@<IP_FROM_STEP_6> "uname -a"
```

Expected: Ubuntu 24.04 kernel info.

- [ ] **Step 8: Point niejedzie.pl DNS via Cloudflare**

In Cloudflare dashboard on the new account:
1. Add domain `niejedzie.pl`
2. A record: `@` → VPS IP (proxy ON = orange cloud)
3. A record: `www` → VPS IP (proxy ON)
4. SSL/TLS mode: Full

- [ ] **Step 9: Verify DNS**

```bash
dig niejedzie.pl +short
```

Expected: Cloudflare IPs (104.x / 172.x). May take 1-2 min to propagate.

- [ ] **Step 10: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
mkdir -p niejedzie-v2/infra
git add niejedzie-v2/infra/provision.sh
git commit -m "feat(v2): hcloud provisioning script"
```

---

### Task 2: Bootstrap the VPS (Node.js, nginx, SQLite, PM2)

**Files:**
- Create: `niejedzie-v2/infra/bootstrap.sh`
- Create: `niejedzie-v2/infra/nginx.conf`

- [ ] **Step 1: Write `niejedzie-v2/infra/bootstrap.sh`**

```bash
#!/usr/bin/env bash
# Run on VPS: ssh root@<ip> 'bash -s' < infra/bootstrap.sh
set -euo pipefail

apt-get update -y
apt-get install -y curl git sqlite3 nginx ufw

# Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version && npm --version

# PM2 process manager
npm install -g pm2
pm2 --version

# App user (non-root)
if ! id niejedzie >/dev/null 2>&1; then
  useradd -m -s /bin/bash niejedzie
  mkdir -p /opt/niejedzie
  chown -R niejedzie:niejedzie /opt/niejedzie
fi

mkdir -p /var/log/niejedzie
chown niejedzie:niejedzie /var/log/niejedzie

# UFW firewall (redundant with Hetzner firewall, belt-and-suspenders)
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable

echo "Bootstrap complete."
```

- [ ] **Step 2: Write `niejedzie-v2/infra/nginx.conf`**

```nginx
server {
  listen 80;
  server_name niejedzie.pl www.niejedzie.pl;

  # Cloudflare handles TLS termination; origin is HTTP.
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 60s;
  }
}
```

- [ ] **Step 3: Run bootstrap on the VPS**

```bash
VPS_IP=$(hcloud server ip niejedzie)
ssh root@$VPS_IP 'bash -s' < niejedzie-v2/infra/bootstrap.sh
```

Expected: ends with `Bootstrap complete.`

- [ ] **Step 4: Install nginx config on the VPS**

```bash
scp niejedzie-v2/infra/nginx.conf root@$VPS_IP:/etc/nginx/sites-available/niejedzie
ssh root@$VPS_IP "ln -sf /etc/nginx/sites-available/niejedzie /etc/nginx/sites-enabled/niejedzie && rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx"
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`.

- [ ] **Step 5: Verify nginx responds with 502 (app not running yet)**

```bash
curl -sI http://$VPS_IP | head -1
```

Expected: `HTTP/1.1 502 Bad Gateway` — nginx working, no app yet.

- [ ] **Step 6: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/infra/bootstrap.sh niejedzie-v2/infra/nginx.conf
git commit -m "feat(v2): VPS bootstrap script + nginx reverse proxy config"
```

---

### Task 3: Scaffold Next.js 15 project

**Files:**
- Create: `niejedzie-v2/` entire directory
- Create: `.env.example`, `.gitignore`

- [ ] **Step 1: Initialize Next.js**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
npx create-next-app@latest niejedzie-v2 --typescript --tailwind --app --src-dir --import-alias "@/*" --use-npm --no-turbopack --eslint --yes
cd niejedzie-v2
```

Expected: Next.js project scaffolded in `niejedzie-v2/`.

- [ ] **Step 2: Install runtime dependencies**

```bash
npm install better-sqlite3 stripe web-push zod dotenv
npm install --save-dev @types/better-sqlite3 @types/web-push tsx vitest
```

- [ ] **Step 3: Write `niejedzie-v2/.env.example`**

```bash
# PKP PLK Open Data API
PKP_API_KEY=ask-maciej-for-the-key

# Stripe (live keys on prod, test keys locally)
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_MONTHLY=price_xxx
STRIPE_PRICE_ONETIME_AMOUNT_GROSZ=500

# VAPID — generate with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:kontakt@niejedzie.pl
NEXT_PUBLIC_VAPID_PUBLIC_KEY=

# SQLite
DATABASE_PATH=./niejedzie.db
```

- [ ] **Step 4: Append to `niejedzie-v2/.gitignore`**

```
.env
.env.local
*.db
*.db-journal
dist-scripts/
```

- [ ] **Step 5: Verify scaffolding builds**

```bash
npm run build
```

Expected: build completes.

- [ ] **Step 6: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/
git commit -m "feat(v2): scaffold Next.js 15 + Tailwind + better-sqlite3 + stripe + web-push"
```

---

### Task 4: SQLite schema + migration script + db helper

**Files:**
- Create: `niejedzie-v2/db/schema.sql`
- Create: `niejedzie-v2/src/lib/db.ts`
- Create: `niejedzie-v2/scripts/migrate.ts`

- [ ] **Step 1: Write `niejedzie-v2/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  data JSON NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS active_trains (
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

CREATE INDEX IF NOT EXISTS idx_active_trains_delayed
  ON active_trains (is_delayed, max_delay DESC);

CREATE TABLE IF NOT EXISTS train_routes (
  operating_date TEXT NOT NULL,
  train_number TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  station_name TEXT,
  station_id INTEGER,
  arrival_time TEXT,
  departure_time TEXT,
  PRIMARY KEY (operating_date, train_number, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_train_routes_station
  ON train_routes (station_name);

CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id TEXT PRIMARY KEY,
  train_number TEXT NOT NULL,
  destination TEXT NOT NULL,
  push_subscription TEXT,
  stripe_session_id TEXT,
  payment_status TEXT DEFAULT 'pending',
  payment_type TEXT,
  status TEXT DEFAULT 'pending',
  operating_date TEXT,
  last_push_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON monitoring_sessions (status, operating_date) WHERE status = 'active';
```

- [ ] **Step 2: Write `niejedzie-v2/src/lib/db.ts`**

```typescript
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

const DATABASE_PATH = process.env.DATABASE_PATH || "./niejedzie.db";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DATABASE_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function migrate(): void {
  const schemaPath = join(process.cwd(), "db/schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db().exec(schema);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
```

- [ ] **Step 3: Write `niejedzie-v2/scripts/migrate.ts`**

```typescript
#!/usr/bin/env tsx
import { migrate, closeDb } from "../src/lib/db";

try {
  migrate();
  console.log("✓ Schema applied.");
} finally {
  closeDb();
}
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "test": "vitest run",
  "migrate": "tsx scripts/migrate.ts"
}
```

- [ ] **Step 5: Run migration**

```bash
cd niejedzie-v2
npm run migrate
sqlite3 niejedzie.db "SELECT name FROM sqlite_master WHERE type='table';"
```

Expected: prints `stats`, `active_trains`, `train_routes`, `monitoring_sessions`.

- [ ] **Step 6: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/db/ niejedzie-v2/scripts/migrate.ts niejedzie-v2/src/lib/db.ts niejedzie-v2/package.json
git commit -m "feat(v2): SQLite schema + migration script + db client"
```

---

## Phase 2 — PKP API client + cron scripts (~1 hour)

### Task 5: Time helpers + PKP API client

**Files:**
- Create: `niejedzie-v2/src/lib/time.ts`
- Create: `niejedzie-v2/src/lib/pkp-api.ts`
- Create: `niejedzie-v2/src/lib/constants.ts`
- Create: `niejedzie-v2/tests/time.test.ts`
- Create: `niejedzie-v2/tests/pkp-api.test.ts`

- [ ] **Step 1: Write `niejedzie-v2/src/lib/time.ts`**

```typescript
const WARSAW_TZ = "Europe/Warsaw";

function warsawParts(now = new Date()): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function todayWarsaw(): string {
  const { year, month, day } = warsawParts();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function yesterdayWarsaw(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 24);
  const { year, month, day } = warsawParts(d);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Write `niejedzie-v2/tests/time.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { todayWarsaw, yesterdayWarsaw } from "../src/lib/time";

describe("time", () => {
  it("todayWarsaw returns YYYY-MM-DD", () => {
    expect(todayWarsaw()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("yesterdayWarsaw is one calendar day before today", () => {
    const today = new Date(todayWarsaw() + "T00:00:00Z");
    const yesterday = new Date(yesterdayWarsaw() + "T00:00:00Z");
    expect((today.getTime() - yesterday.getTime()) / 86_400_000).toBeCloseTo(1, 0);
  });
});
```

- [ ] **Step 3: Write `niejedzie-v2/src/lib/pkp-api.ts`**

```typescript
const API_BASE = "https://pdp-api.plk-sa.pl";
const MAX_ATTEMPTS = 3;

export interface RouteDto {
  scheduleId: number;
  orderId: number;
  trainOrderId?: number;
  name?: string | null;
  carrierCode?: string | null;
  nationalNumber?: string | null;
  internationalDepartureNumber?: string | null;
  internationalArrivalNumber?: string | null;
  commercialCategorySymbol?: string | null;
  operatingDates?: string[];
  stations?: ScheduleStationDto[];
}

export interface ScheduleStationDto {
  stationId: number;
  orderNumber: number;
  arrivalTime?: string;
  departureTime?: string;
}

export interface OperationStationDto {
  stationId: number;
  plannedArrival?: string | null;
  plannedDeparture?: string | null;
  actualArrival?: string | null;
  actualDeparture?: string | null;
  arrivalDelayMinutes?: number;
  departureDelayMinutes?: number;
  isCancelled?: boolean;
}

export interface TrainOperationDto {
  scheduleId: number;
  orderId: number;
  operatingDate: string;
  trainStatus: string | null;
  stations: OperationStationDto[];
}

export interface StatisticsResponse {
  totalTrains: number;
  notStarted: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  partialCancelled: number;
}

export function extractTrainNumber(route: RouteDto): string {
  for (const key of [
    "nationalNumber",
    "internationalDepartureNumber",
    "internationalArrivalNumber",
    "name",
  ] as const) {
    const v = route[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return `${route.scheduleId}/${route.orderId}`;
}

async function pkpFetch<T>(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
): Promise<T | null> {
  const url = new URL(path, API_BASE);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status < 500 || attempt === MAX_ATTEMPTS) {
        console.error(`[pkp] ${res.status} on ${path}`);
        return null;
      }
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`[pkp] network error on ${path}: ${err}`);
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return null;
}

export async function fetchStatistics(apiKey: string, date: string): Promise<StatisticsResponse | null> {
  return pkpFetch<StatisticsResponse>("/api/v1/operations/statistics", apiKey, { date });
}

export async function fetchOperationsPage(
  apiKey: string,
  page: number,
  pageSize = 2000,
): Promise<{ trains: TrainOperationDto[]; stations: Record<string, string>; hasNextPage: boolean } | null> {
  const res = await pkpFetch<{
    trains: TrainOperationDto[];
    stations: Record<string, string>;
    pagination: { hasNextPage: boolean };
  }>("/api/v1/operations", apiKey, {
    fullRoutes: "true",
    withPlanned: "true",
    page: String(page),
    pageSize: String(pageSize),
  });
  if (!res) return null;
  return { trains: res.trains, stations: res.stations, hasNextPage: res.pagination.hasNextPage };
}

export async function fetchSchedules(
  apiKey: string,
  date: string,
): Promise<{ routes: RouteDto[]; stations: Record<string, string> } | null> {
  const res = await pkpFetch<{
    routes: RouteDto[];
    dictionaries?: { stations?: Record<string, { name: string } | string> };
  }>("/api/v1/schedules", apiKey, {
    dateFrom: date,
    dateTo: date,
    dictionaries: "true",
    pageSize: "10000",
  });
  if (!res) return null;
  const stations: Record<string, string> = {};
  for (const [sid, info] of Object.entries(res.dictionaries?.stations ?? {})) {
    stations[sid] = typeof info === "string" ? info : info.name;
  }
  return { routes: res.routes, stations };
}
```

- [ ] **Step 4: Write `niejedzie-v2/tests/pkp-api.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { extractTrainNumber } from "../src/lib/pkp-api";

describe("extractTrainNumber", () => {
  it("prefers nationalNumber", () => {
    expect(extractTrainNumber({ nationalNumber: "49015", name: "X", scheduleId: 2026, orderId: 1 } as any))
      .toBe("49015");
  });

  it("falls through to internationalDepartureNumber", () => {
    expect(extractTrainNumber({
      nationalNumber: null, internationalDepartureNumber: "5680",
      scheduleId: 2026, orderId: 1
    } as any)).toBe("5680");
  });

  it("falls through to internationalArrivalNumber", () => {
    expect(extractTrainNumber({ internationalArrivalNumber: "5387", scheduleId: 2026, orderId: 1 } as any))
      .toBe("5387");
  });

  it("falls through to name", () => {
    expect(extractTrainNumber({ name: "KASZTELAN", scheduleId: 2026, orderId: 1 } as any))
      .toBe("KASZTELAN");
  });

  it("final fallback is compound placeholder", () => {
    expect(extractTrainNumber({ scheduleId: 2026, orderId: 12345 } as any)).toBe("2026/12345");
  });

  it("strips whitespace", () => {
    expect(extractTrainNumber({ nationalNumber: "  49015  ", scheduleId: 2026, orderId: 1 } as any))
      .toBe("49015");
  });

  it("treats empty string as missing", () => {
    expect(extractTrainNumber({ nationalNumber: "", name: "FOO", scheduleId: 2026, orderId: 1 } as any))
      .toBe("FOO");
  });
});
```

- [ ] **Step 5: Write `niejedzie-v2/src/lib/constants.ts`**

```typescript
export const PRICES = {
  ONETIME_GROSZ: 500,
  MONTHLY_GROSZ: 1500,
} as const;

export const TRAIN_OPERATORS: Record<string, { name: string; color: string }> = {
  IC: { name: "PKP Intercity", color: "red" },
  PR: { name: "PolRegio", color: "blue" },
  KD: { name: "Koleje Dolnośląskie", color: "blue" },
  KS: { name: "Koleje Śląskie", color: "blue" },
  KW: { name: "Koleje Wielkopolskie", color: "blue" },
  LKA: { name: "Łódzka Kolej Aglomeracyjna", color: "blue" },
  KML: { name: "Koleje Małopolskie", color: "blue" },
  KM: { name: "Koleje Mazowieckie", color: "green" },
  SKM: { name: "SKM Trójmiasto", color: "green" },
  SKMT: { name: "SKM Warszawa", color: "green" },
  WKD: { name: "WKD", color: "green" },
  AR: { name: "Arriva RP", color: "purple" },
  RJ: { name: "RegioJet", color: "purple" },
  LEO: { name: "Leo Express", color: "purple" },
  UNKNOWN: { name: "Nieznany przewoźnik", color: "gray" },
};

const SHORT_TO_CODE: Record<string, keyof typeof TRAIN_OPERATORS> = {
  IC: "IC", EIC: "IC", EIP: "IC", TLK: "IC",
  PR: "PR",
  KD: "KD", KS: "KS", KW: "KW",
  KM: "KM", "KMŁ": "KML",
  "ŁKA": "LKA",
  SKM: "SKM", SKMT: "SKMT", WKD: "WKD",
  AR: "AR", RJ: "RJ",
  LEO: "LEO", "LEO EXPRESS": "LEO",
};

export function carrierToCode(carrier?: string | null): keyof typeof TRAIN_OPERATORS {
  if (!carrier) return "UNKNOWN";
  const trimmed = carrier.trim();
  return SHORT_TO_CODE[trimmed.toUpperCase()] ?? SHORT_TO_CODE[trimmed] ?? "UNKNOWN";
}
```

- [ ] **Step 6: Run tests**

```bash
cd niejedzie-v2
npx vitest run
```

Expected: 2 time tests + 7 extractTrainNumber tests = 9 passing.

- [ ] **Step 7: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/lib/time.ts niejedzie-v2/src/lib/pkp-api.ts niejedzie-v2/src/lib/constants.ts niejedzie-v2/tests/
git commit -m "feat(v2): PKP API client with retry + Warsaw-tz helpers + operator constants"
```

---

### Task 6: poll-operations cron script

**Files:**
- Create: `niejedzie-v2/scripts/poll-operations.ts`

- [ ] **Step 1: Write `niejedzie-v2/scripts/poll-operations.ts`**

```typescript
#!/usr/bin/env tsx
import { db } from "../src/lib/db";
import { fetchOperationsPage, fetchStatistics, type TrainOperationDto } from "../src/lib/pkp-api";
import { todayWarsaw } from "../src/lib/time";
import { config as loadEnv } from "dotenv";
loadEnv();

async function main() {
  const apiKey = process.env.PKP_API_KEY;
  if (!apiKey) { console.error("PKP_API_KEY missing"); process.exit(1); }
  const today = todayWarsaw();
  console.log(`[poll] ${new Date().toISOString()} — polling for ${today}`);

  const stats = await fetchStatistics(apiKey, today);
  const trainsSeen: TrainOperationDto[] = [];
  const stationDict: Record<string, string> = {};
  let page = 1;
  while (page <= 50) {
    const result = await fetchOperationsPage(apiKey, page);
    if (!result || result.trains.length === 0) break;
    trainsSeen.push(...result.trains);
    Object.assign(stationDict, result.stations);
    if (!result.hasNextPage) break;
    page++;
  }

  const upsertTrain = db().prepare(`
    INSERT INTO active_trains
      (operating_date, train_number, carrier, route_start, route_end,
       is_delayed, max_delay, schedule_id, order_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(operating_date, train_number) DO UPDATE SET
      carrier = excluded.carrier,
      route_start = excluded.route_start,
      route_end = excluded.route_end,
      is_delayed = excluded.is_delayed,
      max_delay = excluded.max_delay,
      schedule_id = excluded.schedule_id,
      order_id = excluded.order_id,
      updated_at = datetime('now')
  `);

  const topDelayed: Array<{ trainNumber: string; delay: number; route: string; station: string; carrier: string }> = [];
  let totalTrainsSeen = 0, totalDelay = 0, delayCount = 0, onTimeCount = 0, cancelledCount = 0;

  const insertMany = db().transaction((trains: TrainOperationDto[]) => {
    for (const train of trains) {
      if (train.trainStatus === "S") { onTimeCount++; continue; }
      totalTrainsSeen++;
      let maxDelay = 0;
      for (const st of train.stations ?? []) {
        const d = st.arrivalDelayMinutes ?? st.departureDelayMinutes ?? 0;
        if (Math.abs(d) > Math.abs(maxDelay)) maxDelay = d;
        if (st.isCancelled) cancelledCount++;
      }
      if (maxDelay > 0) { totalDelay += maxDelay; delayCount++; }
      if (maxDelay <= 5) onTimeCount++;

      const first = train.stations?.[0];
      const last = train.stations?.[train.stations.length - 1];
      const routeStart = first ? (stationDict[String(first.stationId)] ?? "") : "";
      const routeEnd = last ? (stationDict[String(last.stationId)] ?? "") : "";
      const trainNumber = `${train.scheduleId}/${train.orderId}`;

      upsertTrain.run(train.operatingDate || today, trainNumber, null, routeStart, routeEnd,
        maxDelay > 5 ? 1 : 0, maxDelay, train.scheduleId, train.orderId);

      if (maxDelay > 0) {
        topDelayed.push({
          trainNumber, delay: maxDelay, route: `${routeStart} → ${routeEnd}`,
          station: last ? (stationDict[String(last.stationId)] ?? "") : "", carrier: "",
        });
      }
    }
  });
  insertMany(trainsSeen);

  const avgDelay = delayCount > 0 ? Math.round((totalDelay / delayCount) * 10) / 10 : 0;
  const punctuality = totalTrainsSeen > 0 ? Math.round((onTimeCount / totalTrainsSeen) * 1000) / 10 : 0;
  topDelayed.sort((a, b) => b.delay - a.delay);

  const statsData = {
    timestamp: new Date().toISOString(),
    totalTrains: stats?.totalTrains ?? totalTrainsSeen,
    punctuality, avgDelay,
    cancelled: stats?.cancelled ?? cancelledCount,
    topDelayed: topDelayed.slice(0, 10),
  };

  db().prepare(
    `INSERT INTO stats (key, data, updated_at) VALUES ('today', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
  ).run(JSON.stringify(statsData));

  console.log(`[poll] done — ${totalTrainsSeen} trains, ${punctuality}% punct, ${avgDelay} min avg, ${cancelledCount} cancelled`);
}

main().catch((err) => { console.error("[poll] fatal:", err); process.exit(1); }).finally(() => process.exit(0));
```

- [ ] **Step 2: Create local `.env` with your PKP_API_KEY**

```bash
cd niejedzie-v2
cp .env.example .env
# Edit .env, set PKP_API_KEY to real value
```

- [ ] **Step 3: Run poll once locally**

```bash
npm run migrate
npx tsx scripts/poll-operations.ts
```

Expected: `[poll] done — NNN trains, ...` after 30-60 seconds.

- [ ] **Step 4: Verify SQLite has data**

```bash
sqlite3 niejedzie.db "SELECT json_extract(data, '\$.totalTrains'), json_extract(data, '\$.punctuality') FROM stats WHERE key='today';"
sqlite3 niejedzie.db "SELECT COUNT(*) FROM active_trains;"
```

Expected: reasonable numbers (trains > 100, punctuality 70-100).

- [ ] **Step 5: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/scripts/poll-operations.ts niejedzie-v2/package.json niejedzie-v2/package-lock.json
git commit -m "feat(v2): poll-operations cron — PKP API to stats + active_trains"
```

---

### Task 7: sync-routes + prune cron scripts

**Files:**
- Create: `niejedzie-v2/scripts/sync-routes.ts`
- Create: `niejedzie-v2/scripts/prune.ts`

- [ ] **Step 1: Write `niejedzie-v2/scripts/sync-routes.ts`**

```typescript
#!/usr/bin/env tsx
import { db } from "../src/lib/db";
import { fetchSchedules, extractTrainNumber } from "../src/lib/pkp-api";
import { todayWarsaw, yesterdayWarsaw } from "../src/lib/time";
import { config as loadEnv } from "dotenv";
loadEnv();

async function syncDate(apiKey: string, date: string): Promise<number> {
  console.log(`[sync-routes] ${date}`);
  const result = await fetchSchedules(apiKey, date);
  if (!result) { console.error(`[sync-routes] no data for ${date}`); return 0; }

  const upsertRoute = db().prepare(`
    INSERT INTO train_routes
      (operating_date, train_number, stop_sequence, station_name, station_id, arrival_time, departure_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(operating_date, train_number, stop_sequence) DO UPDATE SET
      station_name = excluded.station_name,
      station_id = excluded.station_id,
      arrival_time = excluded.arrival_time,
      departure_time = excluded.departure_time
  `);

  const insertMany = db().transaction((routes: typeof result.routes) => {
    for (const route of routes) {
      const trainNumber = extractTrainNumber(route);
      for (const st of route.stations ?? []) {
        upsertRoute.run(date, trainNumber, st.orderNumber,
          result.stations[String(st.stationId)] ?? "", st.stationId,
          st.arrivalTime ?? null, st.departureTime ?? null);
      }
    }
  });
  insertMany(result.routes);
  console.log(`[sync-routes] ${date} — ${result.routes.length} routes`);
  return result.routes.length;
}

async function main() {
  const apiKey = process.env.PKP_API_KEY;
  if (!apiKey) { console.error("PKP_API_KEY missing"); process.exit(1); }
  const n1 = await syncDate(apiKey, todayWarsaw());
  const n2 = await syncDate(apiKey, yesterdayWarsaw());
  console.log(`[sync-routes] total: ${n1} today + ${n2} yesterday`);
}

main().catch((err) => { console.error("[sync-routes] fatal:", err); process.exit(1); }).finally(() => process.exit(0));
```

- [ ] **Step 2: Write `niejedzie-v2/scripts/prune.ts`**

```typescript
#!/usr/bin/env tsx
import { db } from "../src/lib/db";

const r1 = db().prepare("DELETE FROM active_trains WHERE operating_date < date('now', '-3 days')").run();
const r2 = db().prepare("DELETE FROM train_routes WHERE operating_date < date('now', '-3 days')").run();
const r3 = db().prepare("DELETE FROM monitoring_sessions WHERE created_at < datetime('now', '-7 days') AND status != 'active'").run();

console.log(`[prune] active_trains: ${r1.changes}, train_routes: ${r2.changes}, sessions: ${r3.changes}`);
process.exit(0);
```

- [ ] **Step 3: Run both locally**

```bash
cd niejedzie-v2
npx tsx scripts/sync-routes.ts
npx tsx scripts/prune.ts
sqlite3 niejedzie.db "SELECT COUNT(*) FROM train_routes;"
```

Expected: sync-routes populates thousands of rows; prune runs clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/scripts/sync-routes.ts niejedzie-v2/scripts/prune.ts
git commit -m "feat(v2): sync-routes + prune cron scripts"
```

---

**→ Continue with Part 2:** `2026-04-12-niejedzie-v2-rebuild-part2.md` for frontend pages, payments, push notifications, and deployment.
