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
