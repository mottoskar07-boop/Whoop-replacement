#!/usr/bin/env python3
"""
Garmin Connect wellness sync.

Pulls raw daily wellness data (sleep, HRV, resting HR, stress, body battery,
stats) and activities (with per-activity detail, including HR streams) for
the last N days, and writes the ENTIRE response object for each endpoint
into a single data.json. Nothing is pre-filtered to "the fields we think we
need" -- step 3 of the dashboard build reads the raw key names out of this
file directly.

First run (interactive, once):
    python3 sync.py --days 90
    -> prompts for email, then a real masked password prompt (getpass)
    -> on success, caches a session token under ~/.garminconnect/
    -> if your account has MFA enabled, prompts for the one-time code too

Every run after that (e.g. from a daily cron job):
    python3 sync.py --days 90
    -> reuses the cached token, no password prompt, no network call to
       any credential endpoint
    -> only re-prompts if the cached token has expired/been revoked

Re-running is safe and incremental: days already present in data.json are
skipped unless --refresh is passed, so a rate-limit or crash partway
through a 90-day backfill just needs a re-run to pick up where it left off.
"""

import argparse
import getpass
import json
import os
import sys
import time
from datetime import date, timedelta

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

TOKENSTORE = os.path.expanduser("~/.garminconnect")
REQUEST_PAUSE_SECONDS = 0.6  # be polite to Garmin's API; avoid rate-limiting a 90-day backfill


def _prompt_mfa():
    return input("Garmin MFA one-time code: ").strip()


def init_api():
    """Log in, preferring a cached token so cron runs never need a password.

    garmin.login(tokenstore) tries the cached token first and only falls
    back to self.username/self.password (raising GarminConnectAuthenticationError
    if neither is set) when the cache is missing or invalid -- so the first
    attempt below intentionally carries no credentials.
    """
    garmin = Garmin(prompt_mfa=_prompt_mfa)
    try:
        garmin.login(TOKENSTORE)
        print("Logged in using cached session token.", file=sys.stderr)
        return garmin
    except (FileNotFoundError, GarminConnectAuthenticationError, GarminConnectConnectionError):
        pass

    email = input("Garmin Connect email: ").strip()
    password = getpass.getpass("Garmin Connect password (not echoed): ")

    garmin = Garmin(email=email, password=password, prompt_mfa=_prompt_mfa)
    try:
        garmin.login(TOKENSTORE)
    except GarminConnectAuthenticationError as e:
        sys.exit(f"Login failed: {e}")

    print(f"Login succeeded. Session token cached at {TOKENSTORE} for future runs.", file=sys.stderr)
    return garmin


def safe_call(fn, *args, **kwargs):
    """Call a Garmin API method, tolerating per-endpoint gaps without killing the run."""
    try:
        time.sleep(REQUEST_PAUSE_SECONDS)
        return fn(*args, **kwargs)
    except GarminConnectTooManyRequestsError:
        print("Rate-limited; backing off 60s...", file=sys.stderr)
        time.sleep(60)
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            return {"_error": f"{type(e).__name__}: {e}"}
    except Exception as e:
        return {"_error": f"{type(e).__name__}: {e}"}


def fetch_day(garmin, day_str):
    return {
        "date": day_str,
        "sleep": safe_call(garmin.get_sleep_data, day_str),
        "hrv": safe_call(garmin.get_hrv_data, day_str),
        "heart_rates": safe_call(garmin.get_heart_rates, day_str),
        "stats": safe_call(garmin.get_stats, day_str),
        "stress": safe_call(garmin.get_stress_data, day_str),
        "body_battery": safe_call(garmin.get_body_battery, day_str, day_str),
    }


def fetch_activities(garmin, start_str, end_str):
    """List every activity in the window, then pull full per-activity detail
    (including the HR-per-sample stream needed for TRIMP) for each one."""
    activities = safe_call(garmin.get_activities_by_date, start_str, end_str)
    if not isinstance(activities, list):
        return {"_error": "activity list fetch failed", "raw": activities}

    detailed = {}
    for act in activities:
        act_id = act.get("activityId")
        if act_id is None:
            continue
        detailed[str(act_id)] = {
            "summary": act,
            "details": safe_call(garmin.get_activity_details, act_id),
            "hr_in_timezones": safe_call(garmin.get_activity_hr_in_timezones, act_id),
        }
    return detailed


def load_existing(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"days": {}, "activities": {}}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=90, help="how many days back to pull (default 90)")
    parser.add_argument("--output", default=os.path.join(os.path.dirname(__file__), "data.json"))
    parser.add_argument("--refresh", action="store_true", help="re-fetch days already present in output")
    args = parser.parse_args()

    garmin = init_api()

    store = load_existing(args.output)
    store.setdefault("days", {})
    store.setdefault("activities", {})

    today = date.today()
    start = today - timedelta(days=args.days - 1)

    print(f"Pulling {args.days} days: {start.isoformat()} .. {today.isoformat()}", file=sys.stderr)

    for i in range(args.days):
        d = start + timedelta(days=i)
        d_str = d.isoformat()
        if d_str in store["days"] and not args.refresh:
            continue
        print(f"  {d_str} ...", file=sys.stderr, end=" ")
        store["days"][d_str] = fetch_day(garmin, d_str)
        print("done", file=sys.stderr)
        # write incrementally so a crash/rate-limit partway through doesn't lose progress
        with open(args.output, "w") as f:
            json.dump(store, f, indent=2, default=str)

    print("Pulling activities...", file=sys.stderr)
    new_activities = fetch_activities(garmin, start.isoformat(), today.isoformat())
    store["activities"].update(new_activities)
    store["synced_at"] = today.isoformat()

    with open(args.output, "w") as f:
        json.dump(store, f, indent=2, default=str)

    print(f"Wrote {args.output}", file=sys.stderr)
    print(f"  days: {len(store['days'])}, activities: {len(store['activities'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
