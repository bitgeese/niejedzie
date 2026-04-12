"""Modal app for niejedzie.pl — HTTP-triggered worker.

Modal Starter plan has a 5-cron cap across the account and we're already at
5 from supplementchecker + checkpeptides. So instead of Modal cron
schedules, niejedzie's existing Cloudflare cron worker fires POST requests
to three Modal web endpoints, which then spawn the heavy work on Modal.

Endpoints (all POST, header `X-Trigger-Token` must match env `TRIGGER_TOKEN`):
- /trigger_poll_operations  — spawns poll_operations work (5-min cadence from CF)
- /trigger_poll_disruptions — spawns poll_disruptions work (5-min cadence from CF)
- /trigger_sync_daily       — spawns sync_daily work (daily 02:00 UTC from CF)

Deploy:
    cd pipeline && modal deploy modal_cron.py

Manual run (bypasses HTTP, useful for local debug):
    modal run modal_cron.py::poll_operations_work
"""
import os
import modal
from fastapi import Request, HTTPException

app = modal.App("niejedzie-cron")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("requests>=2.31", "python-dateutil>=2.8", "fastapi[standard]")
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
    modal.Secret.from_name("niejedzie-trigger"),
]

RETRIES = modal.Retries(
    max_retries=2,
    backoff_coefficient=2.0,
    initial_delay=10.0,
)


# ---------------------------------------------------------------------------
# Heavy work functions — spawned asynchronously from the HTTP trigger layer.
# No schedule — the Cloudflare Worker cron fires the HTTP endpoints, which
# .spawn() these to run the actual work on Modal compute.
# ---------------------------------------------------------------------------

@app.function(
    image=image,
    secrets=SECRETS,
    timeout=900,                # 15 min — CF D1 REST API is per-HTTP-call,
                                # ~50K rows × ~7 rows/call × 50ms ≈ 6 min.
                                # Keep headroom for retries and slow days.
    retries=RETRIES,
    max_containers=1,           # Serialize invocations — CF Worker cron
                                # fires every 5 min; if one poll is still
                                # running, queue the next instead of racing.
)
def poll_operations_work():
    import poll_operations as impl
    impl.poll_operations()


@app.function(
    image=image,
    secrets=SECRETS,
    timeout=60,
    retries=RETRIES,
    max_containers=1,
)
def poll_disruptions_work():
    import poll_disruptions as impl
    impl.poll_disruptions()


@app.function(
    image=image,
    secrets=SECRETS,
    timeout=900,
    retries=modal.Retries(max_retries=1, initial_delay=60.0),
)
def sync_daily_work():
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


# ---------------------------------------------------------------------------
# HTTP trigger endpoints — thin layer: auth check + spawn.
# ---------------------------------------------------------------------------

def _check_token(headers) -> bool:
    expected = os.environ.get("TRIGGER_TOKEN")
    provided = headers.get("x-trigger-token") or headers.get("X-Trigger-Token")
    return bool(expected) and provided == expected


@app.function(image=image, secrets=SECRETS)
@modal.fastapi_endpoint(method="POST", docs=False)
def trigger_poll_operations(request: Request):
    if not _check_token(request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    call = poll_operations_work.spawn()
    return {"status": "spawned", "call_id": call.object_id}


@app.function(image=image, secrets=SECRETS)
@modal.fastapi_endpoint(method="POST", docs=False)
def trigger_poll_disruptions(request: Request):
    if not _check_token(request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    call = poll_disruptions_work.spawn()
    return {"status": "spawned", "call_id": call.object_id}


@app.function(image=image, secrets=SECRETS)
@modal.fastapi_endpoint(method="POST", docs=False)
def trigger_sync_daily(request: Request):
    if not _check_token(request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    call = sync_daily_work.spawn()
    return {"status": "spawned", "call_id": call.object_id}
