# niejedzie.pl v2 — Implementation Plan Part 2

Continuation of `2026-04-12-niejedzie-v2-rebuild.md`. Covers Phase 3-5: frontend pages, payments + push, deploy + verify.

---

## Phase 3 — Frontend pages (~2 hours)

### Task 8: Global styles with v1 design tokens

**Files:**
- Modify: `niejedzie-v2/src/app/globals.css`
- Modify: `niejedzie-v2/src/app/layout.tsx`

- [ ] **Step 1: Replace `niejedzie-v2/src/app/globals.css`**

```css
@import "tailwindcss";

@theme {
  --color-cream: #fffbf5;
  --color-cream-dark: #faf3e7;
  --color-brand-500: #c2410c;
  --color-brand-600: #9a3412;
  --color-ink: #1c1917;
  --color-ink-muted: #57534e;
  --color-ink-faint: #a8a29e;
  --color-surface-raised: #ffffff;
  --color-surface-sunken: #f5efe5;
  --color-border: #e7e5e4;
  --color-border-strong: #d6d3d1;
  --color-delay-high: #dc2626;

  --font-sans: "Outfit", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

html, body { background: var(--color-cream); color: var(--color-ink); }

.btn-primary {
  @apply inline-flex items-center justify-center rounded-xl bg-[var(--color-brand-500)] text-white font-bold px-6 py-3 hover:bg-[var(--color-brand-600)] transition-colors;
}
.btn-secondary {
  @apply inline-flex items-center justify-center rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink)] font-semibold px-6 py-3 hover:bg-[var(--color-surface-sunken)] transition-colors;
}

.badge-red    { background: #fee2e2; color: #991b1b; }
.badge-blue   { background: #dbeafe; color: #1e3a8a; }
.badge-green  { background: #dcfce7; color: #14532d; }
.badge-purple { background: #f3e8ff; color: #6b21a8; }
.badge-gray   { background: #f5f5f4; color: #57534e; }
```

- [ ] **Step 2: Update `niejedzie-v2/src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin", "latin-ext"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "niejedzie.pl — Monitor przesiadek PKP",
  description: "Masz przesiadkę? Sprawdzimy czy zdążysz. Monitoring pociągów PKP z powiadomieniami push.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={`${outfit.variable} ${mono.variable}`}>
      <head>
        <script defer data-domain="niejedzie.pl" src="https://plausible.io/js/script.js"></script>
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd niejedzie-v2 && npm run build
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/globals.css niejedzie-v2/src/app/layout.tsx
git commit -m "feat(v2): global styles with v1 design tokens + Google Fonts"
```

---

### Task 9: Homepage with connection form

**Files:**
- Create: `niejedzie-v2/src/components/ConnectionForm.tsx`
- Modify: `niejedzie-v2/src/app/page.tsx`

- [ ] **Step 1: Write `niejedzie-v2/src/components/ConnectionForm.tsx`**

```tsx
"use client";
import { useState } from "react";

export default function ConnectionForm() {
  const [train, setTrain] = useState("");
  const [dest, setDest] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!train.trim() || !dest.trim()) return;
    const params = new URLSearchParams({ train: train.trim(), destination: dest.trim() });
    window.location.href = `/wynik?${params.toString()}`;
  }

  return (
    <form onSubmit={onSubmit} className="bg-white rounded-2xl shadow-lg p-6 space-y-4 max-w-md mx-auto">
      <label className="block">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">Numer pociągu</span>
        <input type="text" value={train} onChange={(e) => setTrain(e.target.value)}
          placeholder="np. IC 5313"
          className="mt-1 w-full rounded-xl border border-[var(--color-border)] px-4 py-3 font-mono focus:border-[var(--color-brand-500)] focus:outline-none"
          required />
      </label>
      <label className="block">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">Dokąd jedziesz</span>
        <input type="text" value={dest} onChange={(e) => setDest(e.target.value)}
          placeholder="np. Kraków Główny"
          className="mt-1 w-full rounded-xl border border-[var(--color-border)] px-4 py-3 focus:border-[var(--color-brand-500)] focus:outline-none"
          required />
      </label>
      <button type="submit" className="btn-primary w-full">Sprawdź połączenie</button>
      <p className="text-center text-xs text-[var(--color-ink-faint)] font-mono">Dane PKP · odświeżane co kilka minut</p>
    </form>
  );
}
```

- [ ] **Step 2: Replace `niejedzie-v2/src/app/page.tsx`**

```tsx
import ConnectionForm from "@/components/ConnectionForm";

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <section className="relative bg-[var(--color-ink)] text-white py-24 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-brand-500)] mb-4">// monitor przesiadek</p>
          <h1 className="text-5xl md:text-6xl font-extrabold leading-tight">
            Masz przesiadkę?<br />
            <span className="text-[var(--color-brand-500)]">Sprawdzimy czy zdążysz.</span>
          </h1>
          <p className="text-lg text-white/70 mt-6 max-w-xl mx-auto">
            Monitorujemy Twój pociąg i wyślemy alert jeśli opóźnienie zagrozi połączeniu.
          </p>
        </div>
        <div className="max-w-xl mx-auto mt-10 relative z-10">
          <ConnectionForm />
        </div>
      </section>

      <section className="py-16 px-6 bg-[var(--color-cream)]">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-3">Jak to działa?</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
            <div className="bg-white rounded-2xl p-6 shadow">
              <div className="text-3xl mb-3">1.</div>
              <h3 className="font-bold mb-2">Podaj trasę</h3>
              <p className="text-sm text-[var(--color-ink-muted)]">Wpisz numer pociągu i stację docelową.</p>
            </div>
            <div className="bg-white rounded-2xl p-6 shadow">
              <div className="text-3xl mb-3">2.</div>
              <h3 className="font-bold mb-2">Włącz monitoring</h3>
              <p className="text-sm text-[var(--color-ink-muted)]">Za 5 zł jednorazowo lub 15 zł/msc bez limitu.</p>
            </div>
            <div className="bg-white rounded-2xl p-6 shadow">
              <div className="text-3xl mb-3">3.</div>
              <h3 className="font-bold mb-2">Reaguj na czas</h3>
              <p className="text-sm text-[var(--color-ink-muted)]">Dostaniesz alert push jeśli opóźnienie zagrozi przesiadce.</p>
            </div>
          </div>
        </div>
      </section>

      <footer className="py-8 border-t border-[var(--color-border)] text-center text-xs text-[var(--color-ink-faint)]">
        <p>Dane z PKP PLK Otwarte Dane Kolejowe · Nie jesteśmy powiązani z PKP S.A.</p>
        <p className="mt-2">© 2026 niejedzie.pl</p>
      </footer>
    </main>
  );
}
```

- [ ] **Step 3: Test + commit**

```bash
cd niejedzie-v2 && npm run build
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/page.tsx niejedzie-v2/src/components/ConnectionForm.tsx
git commit -m "feat(v2): homepage hero + connection form"
```

---

### Task 10: /opoznienia delays dashboard + TrainOperator component

**Files:**
- Create: `niejedzie-v2/src/components/TrainOperator.tsx`
- Create: `niejedzie-v2/src/app/opoznienia/page.tsx`

- [ ] **Step 1: Write `niejedzie-v2/src/components/TrainOperator.tsx`**

```tsx
import { TRAIN_OPERATORS, carrierToCode } from "@/lib/constants";

export default function TrainOperator({ trainNumber, carrier }: { trainNumber: string; carrier?: string | null }) {
  const code = carrierToCode(carrier);
  const op = TRAIN_OPERATORS[code];
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono font-semibold">{trainNumber}</span>
      <span className={`px-2 py-0.5 rounded-md text-xs font-mono font-medium badge-${op.color}`} title={op.name}>
        {code === "UNKNOWN" ? "?" : code}
      </span>
    </span>
  );
}
```

- [ ] **Step 2: Write `niejedzie-v2/src/app/opoznienia/page.tsx`**

```tsx
import { db } from "@/lib/db";
import TrainOperator from "@/components/TrainOperator";

export const dynamic = "force-dynamic";

interface TopDelayed { trainNumber: string; delay: number; route: string; station: string; carrier: string; }
interface StatsData { timestamp: string; totalTrains: number; punctuality: number; avgDelay: number; cancelled: number; topDelayed: TopDelayed[]; }

export default function OpoznieniaPage() {
  const row = db().prepare("SELECT data FROM stats WHERE key = 'today'").get() as { data: string } | undefined;
  const stats: StatsData | null = row ? JSON.parse(row.data) : null;

  return (
    <main className="min-h-screen">
      <section className="bg-[var(--color-cream)] py-12 px-6">
        <div className="max-w-5xl mx-auto">
          <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-faint)]">// opóźnienia na żywo</p>
          <h1 className="text-4xl md:text-5xl font-extrabold">
            Opóźnienia pociągów <span className="text-[var(--color-brand-500)]">dzisiaj</span>
          </h1>
          <p className="mt-4 text-[var(--color-ink-muted)]">
            Aktualne opóźnienia pociągów w Polsce. Dane z PKP PLK odświeżane co 5 minut.
          </p>
          {stats && (
            <p className="text-xs text-[var(--color-ink-faint)] font-mono mt-2">
              Ostatnia aktualizacja: {new Date(stats.timestamp).toLocaleString("pl-PL")} · Źródło: PKP PLK Otwarte Dane Kolejowe
            </p>
          )}
        </div>
      </section>

      {!stats ? (
        <section className="py-12 px-6 max-w-5xl mx-auto">
          <p className="text-center text-[var(--color-ink-muted)]">Dane będą dostępne po pierwszym cyklu cron (~5 min).</p>
        </section>
      ) : (
        <>
          <section className="py-8 px-6 max-w-5xl mx-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Pociągów dzisiaj" value={stats.totalTrains.toString()} />
              <StatCard label="Punktualność" value={`${stats.punctuality}%`} color="green" />
              <StatCard label="Średnie opóźnienie" value={`${stats.avgDelay} min`} color="brand" />
              <StatCard label="Odwołanych" value={stats.cancelled.toString()} color="red" />
            </div>
          </section>

          <section className="py-8 px-6 max-w-5xl mx-auto">
            <h2 className="text-2xl font-bold mb-4">Najbardziej opóźnione pociągi</h2>
            {stats.topDelayed.length === 0 ? (
              <p className="text-[var(--color-ink-muted)]">Brak opóźnionych pociągów — wszystko jedzie na czas.</p>
            ) : (
              <ul className="space-y-2">
                {stats.topDelayed.map((t, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl shadow-sm">
                    <TrainOperator trainNumber={t.trainNumber} carrier={t.carrier} />
                    <span className="flex-1 text-sm text-[var(--color-ink-muted)]">{t.route}</span>
                    <span className="font-mono font-bold text-[var(--color-brand-500)]">+{t.delay} min</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <footer className="py-8 border-t border-[var(--color-border)] text-center text-xs text-[var(--color-ink-faint)]">
        <p>© 2026 niejedzie.pl</p>
      </footer>
    </main>
  );
}

function StatCard({ label, value, color = "ink" }: { label: string; value: string; color?: "ink" | "green" | "brand" | "red"; }) {
  const colorCls = {
    ink: "text-[var(--color-ink)]",
    green: "text-green-600",
    brand: "text-[var(--color-brand-500)]",
    red: "text-[var(--color-delay-high)]",
  }[color];
  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm">
      <div className={`text-3xl md:text-4xl font-bold ${colorCls}`}>{value}</div>
      <div className="font-mono text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mt-2">{label}</div>
    </div>
  );
}
```

- [ ] **Step 3: Test + commit**

```bash
cd niejedzie-v2 && npm run build
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/opoznienia/ niejedzie-v2/src/components/TrainOperator.tsx
git commit -m "feat(v2): /opoznienia delays dashboard + TrainOperator carrier badge"
```

---

### Task 11: /wynik connection check result page

**Files:**
- Create: `niejedzie-v2/src/app/wynik/page.tsx`

- [ ] **Step 1: Write `niejedzie-v2/src/app/wynik/page.tsx`**

```tsx
import { db } from "@/lib/db";
import { todayWarsaw } from "@/lib/time";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Train { train_number: string; carrier: string | null; max_delay: number; is_delayed: number; route_start: string; route_end: string; }
interface RouteStop { stop_sequence: number; station_name: string; arrival_time: string | null; departure_time: string | null; }

function findTrain(trainInput: string): Train | null {
  const today = todayWarsaw();
  const digits = trainInput.replace(/\D/g, "");
  if (!digits) return null;
  return (db().prepare(
    `SELECT train_number, carrier, max_delay, is_delayed, route_start, route_end
     FROM active_trains WHERE operating_date = ? AND train_number LIKE ? LIMIT 1`
  ).get(today, `%${digits}%`) as Train | undefined) ?? null;
}

function findRoute(trainNumber: string): RouteStop[] {
  return db().prepare(
    `SELECT stop_sequence, station_name, arrival_time, departure_time
     FROM train_routes WHERE operating_date = ? AND train_number = ? ORDER BY stop_sequence`
  ).all(todayWarsaw(), trainNumber) as RouteStop[];
}

function destinationOnRoute(route: RouteStop[], destInput: string): RouteStop | null {
  const q = destInput.trim().toLowerCase();
  return route.find((s) => s.station_name.toLowerCase().includes(q)) ?? null;
}

function addDelay(hhmm: string | null, delay: number): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const total = (h * 60 + m + delay + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default async function WynikPage({ searchParams }: { searchParams: Promise<{ train?: string; destination?: string }> }) {
  const { train: trainParam = "", destination: destParam = "" } = await searchParams;
  const trainInput = trainParam.trim();
  const destInput = destParam.trim();

  if (!trainInput || !destInput) {
    return <main className="min-h-screen flex items-center justify-center px-6"><Link href="/" className="btn-primary">Wróć do wyszukiwania</Link></main>;
  }

  const train = findTrain(trainInput);
  if (!train) {
    return (
      <main className="min-h-screen py-16 px-6">
        <div className="max-w-md mx-auto text-center">
          <p className="text-6xl mb-6">🚂</p>
          <h2 className="text-2xl font-bold mb-3">Nie znaleźliśmy pociągu "{trainInput}"</h2>
          <p className="text-[var(--color-ink-muted)] mb-8">
            Dane rozkładowe synchronizujemy codziennie o 02:00. Spróbuj wpisać pełny numer z prefiksem (np. IC 5313).
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Link href="/" className="btn-primary">Wróć do wyszukiwania</Link>
            <Link href="/opoznienia" className="btn-secondary">Opóźnienia dzisiaj</Link>
          </div>
        </div>
      </main>
    );
  }

  const route = findRoute(train.train_number);
  const destStop = destinationOnRoute(route, destInput);
  const delay = train.max_delay || 0;

  return (
    <main className="min-h-screen py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{train.train_number} → {destInput}</h1>
        <p className="font-mono text-xs uppercase tracking-wider text-[var(--color-ink-faint)]">
          // {destStop ? "połączenie bezpośrednie" : "brak bezpośredniego połączenia"}
        </p>

        <div className="bg-white rounded-2xl p-6 mt-8 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <span className="font-mono font-semibold text-lg">{train.train_number}</span>
              {train.carrier && <span className="ml-2 font-mono text-xs text-[var(--color-ink-muted)]">{train.carrier}</span>}
            </div>
            {delay > 0 && <span className="font-mono font-bold text-[var(--color-brand-500)]">+{delay} min</span>}
          </div>

          {destStop ? (
            <div className="mt-6 bg-green-50 rounded-xl p-4">
              <p className="font-bold text-green-900">Jedzie bezpośrednio do {destStop.station_name}</p>
              <p className="text-sm text-green-700 mt-1">Nie potrzebujesz przesiadki</p>
              <div className="mt-4 flex items-baseline gap-3">
                <span className="text-xs uppercase text-green-700">Przyjazd</span>
                {delay > 0 ? (
                  <>
                    <span className="font-mono font-bold text-xl text-green-900">~{addDelay(destStop.arrival_time, delay)}</span>
                    <span className="text-xs text-[var(--color-ink-muted)] font-mono">planowo {destStop.arrival_time}</span>
                  </>
                ) : (
                  <span className="font-mono font-bold text-xl text-green-900">{destStop.arrival_time}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-6 bg-orange-50 rounded-xl p-4">
              <p className="font-bold text-orange-900">Brak bezpośredniego połączenia do "{destInput}"</p>
              <p className="text-sm text-orange-700 mt-1">Ten pociąg nie zatrzymuje się na tej stacji.</p>
            </div>
          )}
        </div>

        {route.length > 0 && (
          <div className="bg-white rounded-2xl p-6 mt-6 shadow-sm">
            <p className="font-mono text-xs uppercase tracking-wider text-[var(--color-ink-faint)] mb-4">// trasa pociągu</p>
            <ul className="space-y-2">
              {route.map((s) => (
                <li key={s.stop_sequence} className={`flex items-center justify-between py-2 ${destStop && s.stop_sequence === destStop.stop_sequence ? "bg-green-50 px-3 rounded-lg" : ""}`}>
                  <span>{s.station_name}</span>
                  <span className="font-mono text-sm text-[var(--color-ink-muted)]">{s.arrival_time ?? s.departure_time ?? ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-8 bg-[var(--color-ink)] text-white rounded-2xl p-6 text-center">
          <h3 className="text-xl font-bold mb-2">Monitoruj tę przesiadkę</h3>
          <p className="text-white/70 mb-4">Wyślemy Ci push jeśli opóźnienie zagrozi Twojemu połączeniu.</p>
          <form method="POST" action="/api/checkout/create" className="flex flex-wrap gap-3 justify-center">
            <input type="hidden" name="trainNumber" value={train.train_number} />
            <input type="hidden" name="destination" value={destInput} />
            <button type="submit" name="mode" value="onetime" className="btn-primary">Monitoruj raz — 5 zł</button>
            <button type="submit" name="mode" value="subscription" className="btn-secondary">Bez limitu — 15 zł/msc</button>
          </form>
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Test + commit**

```bash
cd niejedzie-v2 && npm run build
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/wynik/
git commit -m "feat(v2): /wynik connection checker with delay-aware arrival + Stripe CTA"
```

---

### Task 12: /cennik + /sukces + service worker

**Files:**
- Create: `niejedzie-v2/src/app/cennik/page.tsx`
- Create: `niejedzie-v2/src/app/sukces/page.tsx`
- Create: `niejedzie-v2/public/sw.js`

- [ ] **Step 1: Write `niejedzie-v2/src/app/cennik/page.tsx`**

```tsx
export const dynamic = "force-static";

export default function CennikPage() {
  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-5xl mx-auto text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-faint)]">// cennik</p>
        <h1 className="text-5xl font-extrabold mb-4">Prosty cennik, zero haczyków</h1>
        <p className="text-[var(--color-ink-muted)] max-w-xl mx-auto">
          Sprawdzanie opóźnień jest zawsze darmowe. Płacisz tylko za monitoring przesiadek z powiadomieniami push.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12 max-w-3xl mx-auto">
          <div className="bg-white rounded-2xl p-8 shadow-sm border border-[var(--color-border)]">
            <p className="font-mono text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">jednorazowy</p>
            <div className="flex items-baseline mt-2 mb-1">
              <span className="text-6xl font-mono font-bold">5</span>
              <span className="text-3xl font-mono font-bold ml-2">zł</span>
              <span className="text-[var(--color-ink-muted)] ml-2">/ przesiadka</span>
            </div>
            <p className="text-sm text-[var(--color-ink-muted)] mb-6">Jedziesz raz? To opcja dla Ciebie.</p>
            <ul className="space-y-2 text-sm text-left mb-6">
              <li>✓ Monitoring jednej przesiadki</li>
              <li>✓ Powiadomienia push w czasie rzeczywistym</li>
              <li>✓ Alternatywne połączenia przy opóźnieniu</li>
              <li>✓ Pomoc w odszkodowaniu jeśli &gt;60 min</li>
            </ul>
            <a href="/" className="btn-secondary w-full">Wybierz przesiadkę →</a>
          </div>

          <div className="bg-[var(--color-ink)] text-white rounded-2xl p-8 shadow-xl border-2 border-[var(--color-brand-500)] relative">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[var(--color-brand-500)] text-white text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full">Polecany</span>
            <p className="font-mono text-xs uppercase tracking-wider text-white/60">miesięczny</p>
            <div className="flex items-baseline mt-2 mb-1">
              <span className="text-6xl font-mono font-bold">15</span>
              <span className="text-3xl font-mono font-bold ml-2">zł</span>
              <span className="text-white/60 ml-2">/ miesiąc</span>
            </div>
            <p className="text-sm text-[var(--color-brand-500)] font-bold mb-6">Tyle co 3 jednorazowe — ale bez limitu</p>
            <ul className="space-y-2 text-sm text-left mb-6">
              <li>✓ <strong>Nielimitowany</strong> monitoring wszystkich przesiadek</li>
              <li>✓ Priorytetowe powiadomienia push</li>
              <li>✓ Historia opóźnień Twoich tras</li>
              <li>✓ Alternatywne połączenia + odszkodowania</li>
            </ul>
            <a href="/" className="btn-primary w-full">Zacznij za 15 zł/msc →</a>
            <p className="text-xs text-white/40 mt-3">Anulujesz kiedy chcesz.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Write `niejedzie-v2/src/app/sukces/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function SukcesPage() {
  const [permStatus, setPermStatus] = useState<"idle" | "granted" | "denied" | "unsupported">("idle");
  const params = useSearchParams();
  const sessionId = params.get("session_id");

  useEffect(() => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setPermStatus("unsupported");
      return;
    }
    if (Notification.permission === "granted") {
      setPermStatus("granted");
      subscribePush(sessionId);
    }
  }, [sessionId]);

  async function requestPermission() {
    const result = await Notification.requestPermission();
    if (result === "granted") {
      setPermStatus("granted");
      await subscribePush(sessionId);
    } else {
      setPermStatus("denied");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-6xl mb-6">✅</p>
        <h1 className="text-3xl font-bold mb-4">Płatność zaakceptowana</h1>
        {sessionId && <p className="font-mono text-xs text-[var(--color-ink-faint)] mb-6">ID sesji: {sessionId}</p>}

        {permStatus === "idle" && (
          <>
            <p className="text-[var(--color-ink-muted)] mb-6">Zezwól na powiadomienia push, żebyśmy mogli Cię alertować o opóźnieniach.</p>
            <button onClick={requestPermission} className="btn-primary">Zezwól na powiadomienia</button>
          </>
        )}
        {permStatus === "granted" && (
          <p className="text-green-700 font-bold">✓ Monitoring aktywny. Dostaniesz powiadomienie jeśli opóźnienie zagrozi przesiadce.</p>
        )}
        {permStatus === "denied" && (
          <p className="text-[var(--color-ink-muted)]">Zablokowałeś powiadomienia. Włącz je w ustawieniach przeglądarki i odśwież stronę.</p>
        )}
        {permStatus === "unsupported" && (
          <p className="text-[var(--color-ink-muted)]">Ta przeglądarka nie obsługuje powiadomień push.</p>
        )}
      </div>
    </main>
  );
}

async function subscribePush(sessionId: string | null) {
  if (!sessionId) return;
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
  });
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, subscription }),
  });
}

function urlB64ToUint8Array(b64: string): Uint8Array {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const normalized = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
```

- [ ] **Step 3: Write `niejedzie-v2/public/sw.js`**

```javascript
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "niejedzie.pl";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/"));
});
```

- [ ] **Step 4: Build + commit**

```bash
cd niejedzie-v2 && npm run build
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/cennik/ niejedzie-v2/src/app/sukces/ niejedzie-v2/public/sw.js
git commit -m "feat(v2): /cennik pricing + /sukces post-payment + service worker"
```

---

## Phase 4 — Payments + Push API routes (~1.5 hours)

### Task 13: Stripe lib + checkout create endpoint

**Files:**
- Create: `niejedzie-v2/src/lib/stripe.ts`
- Create: `niejedzie-v2/src/app/api/checkout/create/route.ts`

- [ ] **Step 1: Write `niejedzie-v2/src/lib/stripe.ts`**

```typescript
import Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) throw new Error("STRIPE_SECRET_KEY missing");

export const stripe = new Stripe(secretKey, { apiVersion: "2025-03-31.basil" });
```

- [ ] **Step 2: Write `niejedzie-v2/src/app/api/checkout/create/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { PRICES } from "@/lib/constants";
import { todayWarsaw } from "@/lib/time";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const mode = formData.get("mode") as "onetime" | "subscription";
  const trainNumber = (formData.get("trainNumber") as string)?.trim();
  const destination = (formData.get("destination") as string)?.trim();

  if (!mode || !trainNumber || !destination) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  const sessionId = crypto.randomBytes(16).toString("hex");
  const origin = new URL(req.url).origin;

  db().prepare(
    `INSERT INTO monitoring_sessions (id, train_number, destination, payment_type, status, operating_date)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(sessionId, trainNumber, destination, mode, todayWarsaw());

  const checkout = await stripe.checkout.sessions.create({
    mode: mode === "subscription" ? "subscription" : "payment",
    payment_method_types: ["card", "blik"],
    line_items: mode === "subscription"
      ? [{ price: process.env.STRIPE_PRICE_MONTHLY, quantity: 1 }]
      : [{
          price_data: {
            currency: "pln",
            unit_amount: PRICES.ONETIME_GROSZ,
            product_data: { name: `Monitoring przesiadki: ${trainNumber} → ${destination}` },
          },
          quantity: 1,
        }],
    client_reference_id: sessionId,
    metadata: { sessionId, trainNumber, destination, mode },
    success_url: `${origin}/sukces?session_id=${sessionId}`,
    cancel_url: `${origin}/wynik?train=${encodeURIComponent(trainNumber)}&destination=${encodeURIComponent(destination)}`,
  });

  db().prepare(`UPDATE monitoring_sessions SET stripe_session_id = ? WHERE id = ?`).run(checkout.id, sessionId);

  return NextResponse.redirect(checkout.url!, 303);
}
```

- [ ] **Step 3: Add Stripe test keys to local `.env`**

Edit `niejedzie-v2/.env`:
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_MONTHLY=price_...  (from Stripe dashboard or existing v1 product)
```

- [ ] **Step 4: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/lib/stripe.ts niejedzie-v2/src/app/api/checkout/
git commit -m "feat(v2): Stripe checkout create endpoint"
```

---

### Task 14: Stripe webhook handler

**Files:**
- Create: `niejedzie-v2/src/app/api/webhooks/stripe/route.ts`

- [ ] **Step 1: Write `niejedzie-v2/src/app/api/webhooks/stripe/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const body = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    console.error("[stripe webhook] signature verify failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const sessionId = session.metadata?.sessionId ?? session.client_reference_id;
      if (!sessionId) break;
      db().prepare(
        `UPDATE monitoring_sessions SET payment_status = 'paid', status = 'active' WHERE id = ?`
      ).run(sessionId);
      console.log(`[stripe webhook] session ${sessionId} → active`);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const stripeSession = await stripe.checkout.sessions.list({ subscription: sub.id, limit: 1 });
      const refId = stripeSession.data[0]?.client_reference_id;
      if (refId) {
        db().prepare(`UPDATE monitoring_sessions SET status = 'expired' WHERE id = ?`).run(refId);
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 2: Install + configure Stripe CLI for local webhook forwarding**

```bash
brew install stripe/stripe-cli/stripe
stripe login
# In a separate terminal while dev server runs:
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# Copy the whsec_... value into .env as STRIPE_WEBHOOK_SECRET
```

- [ ] **Step 3: Test with trigger**

```bash
cd niejedzie-v2
npm run dev &
# In another terminal:
stripe trigger checkout.session.completed
# Should see webhook request in dev server logs + 200 OK in stripe listen output
```

- [ ] **Step 4: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/api/webhooks/
git commit -m "feat(v2): Stripe webhook handler — activate session on payment"
```

---

### Task 15: Push helper + subscribe endpoint + check-push cron

**Files:**
- Create: `niejedzie-v2/src/lib/webpush.ts`
- Create: `niejedzie-v2/src/app/api/push/subscribe/route.ts`
- Create: `niejedzie-v2/scripts/check-push.ts`

- [ ] **Step 1: Generate VAPID keys once**

```bash
cd niejedzie-v2
npx web-push generate-vapid-keys
# Copy the 2 keys into .env:
#   VAPID_PUBLIC_KEY=...
#   VAPID_PRIVATE_KEY=...
#   NEXT_PUBLIC_VAPID_PUBLIC_KEY=  (same as public)
#   VAPID_SUBJECT=mailto:kontakt@niejedzie.pl
```

- [ ] **Step 2: Write `niejedzie-v2/src/lib/webpush.ts`**

```typescript
import webpush from "web-push";

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:kontakt@niejedzie.pl";

if (PUBLIC && PRIVATE) webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

export async function sendPush(
  subscription: webpush.PushSubscription,
  payload: { title: string; body: string; url?: string },
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  if (!PUBLIC || !PRIVATE) return { ok: false, error: "VAPID keys not configured" };
  try {
    const res = await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true, statusCode: res.statusCode };
  } catch (err: any) {
    return { ok: false, statusCode: err.statusCode, error: err.message };
  }
}
```

- [ ] **Step 3: Write `niejedzie-v2/src/app/api/push/subscribe/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { z } from "zod";

const Body = z.object({
  sessionId: z.string().min(1),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
});

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { sessionId, subscription } = parsed.data;

  const result = db().prepare(
    `UPDATE monitoring_sessions SET push_subscription = ? WHERE id = ? AND status = 'active'`
  ).run(JSON.stringify(subscription), sessionId);

  if (result.changes === 0) return NextResponse.json({ error: "session not found or not active" }, { status: 404 });
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Write `niejedzie-v2/scripts/check-push.ts`**

```typescript
#!/usr/bin/env tsx
import { db } from "../src/lib/db";
import { sendPush } from "../src/lib/webpush";
import { todayWarsaw } from "../src/lib/time";
import { config as loadEnv } from "dotenv";
loadEnv();

const DELAY_THRESHOLD_MIN = 15;
const MIN_MINUTES_BETWEEN_PUSHES = 30;

interface Session { id: string; train_number: string; destination: string; push_subscription: string | null; last_push_at: string | null; }
interface Train { max_delay: number; carrier: string | null; }

async function main() {
  const today = todayWarsaw();
  const sessions = db().prepare(
    `SELECT id, train_number, destination, push_subscription, last_push_at
     FROM monitoring_sessions
     WHERE status = 'active' AND push_subscription IS NOT NULL AND operating_date = ?`
  ).all(today) as Session[];

  if (sessions.length === 0) { console.log("[check-push] no active sessions"); return; }
  console.log(`[check-push] checking ${sessions.length} sessions`);

  for (const s of sessions) {
    const digits = s.train_number.replace(/\D/g, "");
    const train = db().prepare(
      `SELECT max_delay, carrier FROM active_trains
       WHERE operating_date = ? AND train_number LIKE ? LIMIT 1`
    ).get(today, `%${digits}%`) as Train | undefined;

    if (!train || train.max_delay < DELAY_THRESHOLD_MIN) continue;

    if (s.last_push_at) {
      const last = new Date(s.last_push_at).getTime();
      if (Date.now() - last < MIN_MINUTES_BETWEEN_PUSHES * 60_000) continue;
    }

    const subscription = JSON.parse(s.push_subscription!);
    const result = await sendPush(subscription, {
      title: `Pociąg ${s.train_number} ma opóźnienie`,
      body: `+${train.max_delay} min. Sprawdź czy zdążysz na przesiadkę do ${s.destination}.`,
      url: `/wynik?train=${encodeURIComponent(s.train_number)}&destination=${encodeURIComponent(s.destination)}`,
    });

    if (result.ok) {
      db().prepare(`UPDATE monitoring_sessions SET last_push_at = datetime('now') WHERE id = ?`).run(s.id);
      console.log(`[check-push] pushed to ${s.id} — +${train.max_delay} min`);
    } else {
      console.error(`[check-push] push failed for ${s.id}: ${result.error}`);
      if (result.statusCode === 410) {
        db().prepare(`UPDATE monitoring_sessions SET push_subscription = NULL WHERE id = ?`).run(s.id);
      }
    }
  }
}

main().catch((err) => { console.error("[check-push] fatal:", err); process.exit(1); }).finally(() => process.exit(0));
```

- [ ] **Step 5: Test locally with a synthetic session**

```bash
cd niejedzie-v2
# Find a delayed train from real data:
DELAYED=$(sqlite3 niejedzie.db "SELECT train_number FROM active_trains WHERE max_delay > 15 LIMIT 1;")
echo "Using delayed train: $DELAYED"

# Create a test active session with a fake push subscription
sqlite3 niejedzie.db "INSERT INTO monitoring_sessions (id, train_number, destination, push_subscription, status, operating_date) VALUES ('test-'$(date +%s), '$DELAYED', 'Warszawa', '{\"endpoint\":\"https://httpbin.org/post\",\"keys\":{\"p256dh\":\"BOL8tL_zKk-TRwUKV5kOYxwW8fYXxZ5H1nN-LZG6qJ6pXEJFxLdOCdFs5KG6_xQHQv9xUfvYCN5-jq8mHR0yOW8\",\"auth\":\"dvGtFcuZqvvgfT1gKz6MZQ\"}}', 'active', date('now','localtime'));"

npx tsx scripts/check-push.ts
```

Expected: `[check-push] pushed to test-... — +N min` (httpbin accepts the POST even though it's not a real push endpoint).

- [ ] **Step 6: Cleanup + commit**

```bash
sqlite3 niejedzie.db "DELETE FROM monitoring_sessions WHERE id LIKE 'test-%';"
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/lib/webpush.ts niejedzie-v2/src/app/api/push/ niejedzie-v2/scripts/check-push.ts
git commit -m "feat(v2): push helper + subscribe endpoint + check-push cron"
```

---

## Phase 5 — Deploy + verify (~1 hour)

### Task 16: PM2 + crontab + TS scripts build config

**Files:**
- Create: `niejedzie-v2/ecosystem.config.js`
- Create: `niejedzie-v2/tsconfig.scripts.json`
- Create: `niejedzie-v2/infra/crontab.txt`
- Modify: `niejedzie-v2/package.json` (add build:scripts)

- [ ] **Step 1: Write `niejedzie-v2/ecosystem.config.js`**

```javascript
module.exports = {
  apps: [{
    name: "niejedzie",
    script: "npm",
    args: "start",
    cwd: "/opt/niejedzie/niejedzie-v2",
    instances: 1,
    autorestart: true,
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      DATABASE_PATH: "/opt/niejedzie/niejedzie-v2/niejedzie.db",
    },
  }],
};
```

- [ ] **Step 2: Write `niejedzie-v2/tsconfig.scripts.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-scripts",
    "module": "commonjs",
    "moduleResolution": "node",
    "noEmit": false,
    "declaration": false,
    "sourceMap": false,
    "target": "es2022",
    "isolatedModules": false
  },
  "include": ["scripts/**/*.ts", "src/lib/**/*.ts"],
  "exclude": ["node_modules", "**/*.test.ts"]
}
```

- [ ] **Step 3: Add `build:scripts` to `package.json`**

Add to scripts section:
```json
"build:scripts": "tsc -p tsconfig.scripts.json"
```

- [ ] **Step 4: Write `niejedzie-v2/infra/crontab.txt`**

```
# niejedzie.pl cron — install: sudo -u niejedzie crontab /opt/niejedzie/niejedzie-v2/infra/crontab.txt

# Every 5 min — PKP API poll
*/5 * * * * cd /opt/niejedzie/niejedzie-v2 && /usr/bin/node dist-scripts/scripts/poll-operations.js >> /var/log/niejedzie/poll.log 2>&1

# Every 1 min — check push alerts for active monitoring sessions
* * * * * cd /opt/niejedzie/niejedzie-v2 && /usr/bin/node dist-scripts/scripts/check-push.js >> /var/log/niejedzie/push.log 2>&1

# Daily 01:00 UTC (~02:00-03:00 Warsaw) — sync train_routes
0 1 * * * cd /opt/niejedzie/niejedzie-v2 && /usr/bin/node dist-scripts/scripts/sync-routes.js >> /var/log/niejedzie/sync-routes.log 2>&1

# Daily 02:00 UTC — prune old rows
0 2 * * * cd /opt/niejedzie/niejedzie-v2 && /usr/bin/node dist-scripts/scripts/prune.js >> /var/log/niejedzie/prune.log 2>&1
```

- [ ] **Step 5: Test local build:scripts**

```bash
cd niejedzie-v2
npm run build:scripts
ls dist-scripts/scripts/
```

Expected: 4 .js files present.

- [ ] **Step 6: Commit**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/ecosystem.config.js niejedzie-v2/tsconfig.scripts.json niejedzie-v2/infra/crontab.txt niejedzie-v2/package.json
git commit -m "feat(v2): PM2 ecosystem + TS scripts build target + crontab"
```

---

### Task 17: Deploy to VPS

**Files:** none (bash commands only)

- [ ] **Step 1: Push all commits to GitHub**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git push
```

- [ ] **Step 2: Clone + build on the VPS**

```bash
VPS_IP=$(hcloud server ip niejedzie)
ssh root@$VPS_IP "
  sudo -u niejedzie bash -c '
    cd /opt/niejedzie
    if [ ! -d .git ]; then
      git clone https://github.com/bitgeese/niejedzie.git .
    fi
    git fetch && git checkout main && git pull
    cd niejedzie-v2
    npm ci
    npm run build
    npm run build:scripts
  '
"
```

Expected: npm install + Next.js build + TS compile all succeed.

- [ ] **Step 3: Create prod `.env` on the VPS**

Upload your local `.env` (after confirming it has prod-safe values — LIVE Stripe key, real PKP key, VAPID keys):

```bash
scp niejedzie-v2/.env root@$VPS_IP:/opt/niejedzie/niejedzie-v2/.env
ssh root@$VPS_IP "chown niejedzie:niejedzie /opt/niejedzie/niejedzie-v2/.env && chmod 600 /opt/niejedzie/niejedzie-v2/.env"

# Verify prod values
ssh root@$VPS_IP "sudo -u niejedzie grep -E 'NODE_ENV|DATABASE_PATH|STRIPE_SECRET_KEY' /opt/niejedzie/niejedzie-v2/.env | sed 's/=.*/=<SET>/'"
```

Edit remote `.env` if needed to set:
- `NODE_ENV=production`
- `DATABASE_PATH=/opt/niejedzie/niejedzie-v2/niejedzie.db`
- `STRIPE_SECRET_KEY=sk_live_...` (if going live; stay on test if not)

- [ ] **Step 4: Run migration on VPS**

```bash
ssh root@$VPS_IP "sudo -u niejedzie bash -c 'cd /opt/niejedzie/niejedzie-v2 && npm run migrate'"
```

Expected: `✓ Schema applied.`

- [ ] **Step 5: Start PM2**

```bash
ssh root@$VPS_IP "
  sudo -u niejedzie bash -c '
    cd /opt/niejedzie/niejedzie-v2
    pm2 start ecosystem.config.js
    pm2 save
  '
  env PATH=\$PATH:/usr/bin pm2 startup systemd -u niejedzie --hp /home/niejedzie
"
```

Expected: PM2 process shows `niejedzie online`.

- [ ] **Step 6: Install crontab**

```bash
ssh root@$VPS_IP "sudo -u niejedzie crontab /opt/niejedzie/niejedzie-v2/infra/crontab.txt"
ssh root@$VPS_IP "sudo -u niejedzie crontab -l"
```

Expected: prints the 4 cron lines.

- [ ] **Step 7: Manually trigger first poll + sync**

```bash
ssh root@$VPS_IP "
  sudo -u niejedzie bash -c '
    cd /opt/niejedzie/niejedzie-v2
    node dist-scripts/scripts/poll-operations.js
    node dist-scripts/scripts/sync-routes.js
  '
"
```

Expected: both scripts log `done —` lines.

- [ ] **Step 8: Configure Stripe webhook for production**

In Stripe dashboard (live mode):
- Developers → Webhooks → Add endpoint
- URL: `https://niejedzie.pl/api/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.subscription.deleted`
- Copy the signing secret (whsec_...)

Update the VPS .env:

```bash
ssh root@$VPS_IP "sudo -u niejedzie sed -i 's|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=whsec_NEW_VALUE|' /opt/niejedzie/niejedzie-v2/.env"
ssh root@$VPS_IP "sudo -u niejedzie pm2 restart niejedzie"
```

- [ ] **Step 9: Verify endpoints are live**

```bash
# Homepage
curl -sI https://niejedzie.pl | head -1
# Expected: HTTP/2 200

# Delays dashboard renders
curl -s https://niejedzie.pl/opoznienia | grep -c "Opóźnienia pociągów"
# Expected: 1

# Cennik
curl -s https://niejedzie.pl/cennik | grep -c "Prosty cennik"
# Expected: 1
```

- [ ] **Step 10: Empty-commit the deployment milestone**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git commit --allow-empty -m "ops(v2): deployed to Hetzner fsn1 — PM2 running, crontab installed, first poll done"
git push
```

---

### Task 18: /api/health + final verification audit

**Files:**
- Create: `niejedzie-v2/src/app/api/health/route.ts`

- [ ] **Step 1: Write `niejedzie-v2/src/app/api/health/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const issues: string[] = [];
  let dataAge = 0;
  let lastPoll: string | null = null;

  try {
    const row = db().prepare("SELECT data, updated_at FROM stats WHERE key='today'").get() as
      | { data: string; updated_at: string } | undefined;
    if (!row) {
      issues.push("stats:today missing — cron never ran");
    } else {
      lastPoll = row.updated_at;
      const age = Date.now() - new Date(row.updated_at + "Z").getTime();
      dataAge = Math.floor(age / 60_000);
      if (dataAge >= 30) issues.push(`last poll ${dataAge} min ago`);
    }
  } catch (err) {
    issues.push("DB read failed: " + (err as Error).message);
  }

  if (!process.env.STRIPE_SECRET_KEY) issues.push("Stripe not configured");
  if (!process.env.VAPID_PRIVATE_KEY) issues.push("VAPID keys not configured");

  const status = issues.length === 0 ? "healthy" : dataAge >= 30 ? "unhealthy" : "degraded";

  return NextResponse.json(
    { status, lastPoll, dataAge, issues },
    { status: status === "unhealthy" ? 503 : 200 },
  );
}
```

- [ ] **Step 2: Deploy the health endpoint**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git add niejedzie-v2/src/app/api/health/
git commit -m "feat(v2): /api/health endpoint"
git push

VPS_IP=$(hcloud server ip niejedzie)
ssh root@$VPS_IP "
  sudo -u niejedzie bash -c '
    cd /opt/niejedzie
    git pull
    cd niejedzie-v2
    npm run build
    pm2 restart niejedzie
  '
"
```

- [ ] **Step 3: Final audit**

```bash
# Health
curl -s https://niejedzie.pl/api/health
# Expected: {"status":"healthy","lastPoll":"...","dataAge":N,"issues":[]}

# All 5 pages return 200
for path in / /opoznienia /cennik /sukces; do
  echo "$path → $(curl -s -o /dev/null -w "%{http_code}" "https://niejedzie.pl$path")"
done

# /wynik with real params
REAL_TRAIN=$(ssh root@$VPS_IP "sqlite3 /opt/niejedzie/niejedzie-v2/niejedzie.db 'SELECT train_number FROM active_trains LIMIT 1;'")
echo "/wynik?train=$REAL_TRAIN&destination=Warszawa → $(curl -s -o /dev/null -w "%{http_code}" "https://niejedzie.pl/wynik?train=$REAL_TRAIN&destination=Warszawa")"

# DB state
ssh root@$VPS_IP "
  sqlite3 /opt/niejedzie/niejedzie-v2/niejedzie.db '
    SELECT \"active_trains\", COUNT(*) FROM active_trains;
    SELECT \"train_routes\", COUNT(*) FROM train_routes;
    SELECT \"stats\", json_extract(data, \"\$.totalTrains\") FROM stats WHERE key=\"today\";
  '
"

# Cron running
ssh root@$VPS_IP "tail -5 /var/log/niejedzie/poll.log"
```

- [ ] **Step 4: Declare MVP shipped**

```bash
cd /Users/maciejjanowski/Documents/my-chud-claude-rife/projects/pkp-delay-tracker
git commit --allow-empty -m "milestone: niejedzie.pl v2 MVP shipped

5 pages live, cron running every 5 min, SQLite writes local (zero managed-db cost),
Hetzner CX22 €4.51/mo total infrastructure cost. Stripe in live mode."
git push
```

---

## Rollback plan

| Broken | Rollback command |
|---|---|
| Bad deploy | `ssh vps \"cd /opt/niejedzie && git reset --hard HEAD~1 && cd niejedzie-v2 && npm run build && pm2 restart niejedzie\"` |
| Bad cron job | `ssh vps \"sudo -u niejedzie crontab -r\"` (removes all crons) |
| Full server wipe | `hcloud server delete niejedzie && ./infra/provision.sh` — re-run bootstrap + deploy |
| SQLite corruption | Restore from backup file (add backup cron in Phase 2+) |

## Success criteria (spec §10)

- [ ] 5 pages live at niejedzie.pl (`/`, `/opoznienia`, `/cennik`, `/sukces`, `/wynik`)
- [ ] Cron polls PKP API every 5 min, writes to local SQLite
- [ ] `/opoznienia` shows real live data with correct carriers
- [ ] Connection checker finds trains and checks routes
- [ ] Stripe Checkout opens from CTA, payment completes
- [ ] Push notification fires when monitored train is delayed (server-side verified; client-side test = user's phone checklist)
- [ ] Total hosting cost: €4.51/month (Hetzner CX22)
- [ ] Total managed-service cost: $0/month (other than Stripe per-transaction)
- [ ] Plausible analytics tracking active

## Open questions / known-unknowns

- **Push client-side e2e** requires user to test from their phone after deployment (pay 5 zł → grant notification permission → verify push arrives on delayed train). Server-side verified via synthetic test in Task 15.
- **Cron time zone** — crontab runs in UTC on Ubuntu. Script logs are UTC. The spec says daily sync at 02:00 Warsaw; crontab.txt uses `0 1 * * *` (01:00 UTC = 02:00 CET winter / 03:00 CEST summer). If user cares about exact 02:00 Warsaw, add `TZ=Europe/Warsaw` to the crontab.
- **SQLite backup** — MVP has no automated backup. Phase 2+ task: `rsync niejedzie.db` nightly to a Hetzner Storage Box, or use Litestream for continuous replication.
- **SEO pages deferred** — city pages, per-train pages, `/punktualnosc`, guide pages all Phase 2.
