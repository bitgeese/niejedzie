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
