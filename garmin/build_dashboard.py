#!/usr/bin/env python3
"""
Builds garmin/dashboard.html: a single self-contained HTML file (no
external resources, no build step) showing Recovery, Strain, and Sleep
screens computed from garmin/data.json using the formulas from Step 5
of the build process. Every number on the page traces back to either a
field read from data.json or one of the formulas printed on the page
itself.

Usage:
    python3 build_dashboard.py [data.json] [dashboard.html]
"""
import json
import math
import statistics as st
import sys
from datetime import date, timedelta
from pathlib import Path

BASELINE_SLEEP_HOURS = 8.0


def load(path):
    with open(path) as f:
        return json.load(f)


def build(data):
    """Compute every derived value the dashboard needs. See Step 5 for
    the formulas; nothing here is invented beyond what was already shown
    to and confirmed with the user."""
    days = data["days"]
    acts = data["activities"]
    dates = sorted(days.keys())

    raw = {}
    for dt in dates:
        day = days[dt]
        sleep = day.get("sleep") or {}
        dto = sleep.get("dailySleepDTO") or {}
        hrv = day.get("hrv") or {}
        hrv_summary = hrv.get("hrvSummary") or {}
        stats = day.get("stats") or {}
        stress = day.get("stress") or {}

        raw[dt] = {
            "hrv": hrv_summary.get("lastNightAvg"),
            "hrv_baseline": hrv_summary.get("baseline"),
            "rhr": stats.get("restingHeartRate"),
            "sleep_seconds": dto.get("sleepTimeSeconds"),
            "deep_s": dto.get("deepSleepSeconds"),
            "light_s": dto.get("lightSleepSeconds"),
            "rem_s": dto.get("remSleepSeconds"),
            "awake_s": dto.get("awakeSleepSeconds"),
            "nap_s": dto.get("napTimeSeconds") or 0,
            "sleep_start_gmt": dto.get("sleepStartTimestampGMT"),
            "sleep_end_gmt": dto.get("sleepEndTimestampGMT"),
            "respiration": dto.get("averageRespirationValue"),
            "spo2": dto.get("averageSpO2Value"),
            "skin_temp_dev_c": sleep.get("avgSkinTempDeviationC"),
            "stress_avg": stress.get("avgStressLevel"),
            "steps": stats.get("totalSteps"),
        }

    activities_by_date = {}
    no_hr_activities = []
    for aid, a in acts.items():
        s = a["summary"]
        dt = (s.get("startTimeLocal") or "")[:10]
        entry = {
            "id": aid,
            "name": s.get("activityName"),
            "type": (s.get("activityType") or {}).get("typeKey")
            if isinstance(s.get("activityType"), dict) else s.get("activityType"),
            "duration_s": s.get("duration"),
            "avg_hr": s.get("averageHR"),
            "max_hr": s.get("maxHR"),
            "load": s.get("activityTrainingLoad") or 0.0,
            "start_local": s.get("startTimeLocal"),
        }
        activities_by_date.setdefault(dt, []).append(entry)
        if entry["avg_hr"] is None:
            no_hr_activities.append({"date": dt, "name": entry["name"]})

    def day_load(dt):
        return sum(a["load"] for a in activities_by_date.get(dt, [])) + 4.0

    def strain_raw(dt):
        dl = day_load(dt)
        return 21 * math.log(1 + dl / 12) / math.log(1 + 90 / 12)

    strain_by_date = {dt: strain_raw(dt) for dt in dates}

    hrv_vals = [raw[dt]["hrv"] for dt in dates if raw[dt]["hrv"] is not None]
    hrv_mean = st.mean(hrv_vals)
    hrv_sd = st.pstdev(hrv_vals)

    rhr_series = [(dt, raw[dt]["rhr"]) for dt in dates if raw[dt]["rhr"] is not None]
    rhr_last30 = [v for _, v in rhr_series[-30:]]
    rhr_last14 = [v for _, v in rhr_series[-14:]]
    rhr_mean_30, rhr_sd_30 = st.mean(rhr_last30), st.pstdev(rhr_last30)
    rhr_mean_14, rhr_sd_14 = st.mean(rhr_last14), st.pstdev(rhr_last14)

    sleep_hours_full = [
        raw[dt]["sleep_seconds"] / 3600 for dt in dates
        if raw[dt]["sleep_seconds"] and raw[dt]["sleep_seconds"] / 3600 >= 4
    ]
    naps_excluded = [
        {"date": dt, "hours": round(raw[dt]["sleep_seconds"] / 3600, 2)}
        for dt in dates
        if raw[dt]["sleep_seconds"] and raw[dt]["sleep_seconds"] / 3600 < 4
    ]
    sleep_median = st.median(sleep_hours_full)
    sleep_p75 = st.quantiles(sleep_hours_full, n=4)[2]

    baselines = {
        "hrv": {"n": len(hrv_vals), "mean": hrv_mean, "sd": hrv_sd,
                "min": min(hrv_vals), "max": max(hrv_vals),
                "thin": len(hrv_vals) < 14},
        "rhr_30": {"n": len(rhr_last30), "mean": rhr_mean_30, "sd": rhr_sd_30},
        "rhr_14": {"n": len(rhr_last14), "mean": rhr_mean_14, "sd": rhr_sd_14},
        "sleep": {"n": len(sleep_hours_full), "median": sleep_median, "p75": sleep_p75,
                  "naps_excluded": naps_excluded},
    }

    def clamp(x, lo, hi):
        return max(lo, min(hi, x))

    def sleep_need_for(dt):
        d0 = date.fromisoformat(dt)
        yesterday = (d0 - timedelta(days=1)).isoformat()
        y_strain = strain_by_date.get(yesterday)
        f_strain = (1.7 / (1 + math.exp((17 - y_strain) / 3.5))) if y_strain is not None else 0.0

        prior_dates = [(d0 - timedelta(days=k)).isoformat() for k in (1, 2, 3)]
        shortfalls = []
        for pdt in prior_dates:
            secs = raw.get(pdt, {}).get("sleep_seconds")
            if secs is not None:
                shortfalls.append(max(0, BASELINE_SLEEP_HOURS - secs / 3600))
        debt_raw = 0.35 * sum(shortfalls) if shortfalls else 0.0
        debt = min(debt_raw, 1.5)

        naps_h = (raw.get(dt, {}).get("nap_s") or 0) / 3600
        need = BASELINE_SLEEP_HOURS + f_strain + debt - naps_h
        return {
            "baseline_h": BASELINE_SLEEP_HOURS, "f_strain_h": f_strain,
            "yesterday_strain": y_strain, "debt_h": debt, "debt_raw_h": debt_raw,
            "nights_used_for_debt": len(shortfalls), "naps_h": naps_h, "need_h": need,
        }

    computed = {}
    for dt in dates:
        r = raw[dt]
        need_info = sleep_need_for(dt)
        slept_h = (r["sleep_seconds"] / 3600) if r["sleep_seconds"] else None
        sleep_perf_pct = (slept_h / need_info["need_h"] * 100) if slept_h is not None else None

        weights = {"hrv": 0.50, "rhr": 0.25, "sleep": 0.25}
        scores = {}
        if r["hrv"] is not None and hrv_sd > 0:
            scores["hrv"] = clamp(50 + 20 * ((r["hrv"] - hrv_mean) / hrv_sd), 0, 100)
        if r["rhr"] is not None and rhr_sd_30 > 0:
            scores["rhr"] = clamp(50 - 20 * ((r["rhr"] - rhr_mean_30) / rhr_sd_30), 0, 100)
        if sleep_perf_pct is not None:
            scores["sleep"] = min(100, sleep_perf_pct)

        present_weight = sum(weights[k] for k in scores)
        recovery, used_weights = None, {}
        if present_weight > 0:
            recovery = 0.0
            for k, sc in scores.items():
                w = weights[k] / present_weight
                used_weights[k] = w
                recovery += w * sc

        band = None
        if recovery is not None:
            band = "green" if recovery >= 67 else ("yellow" if recovery >= 34 else "red")
        target_strain = {"green": [14.0, 18.0], "yellow": [9.0, 13.5], "red": [0.0, 8.0]}.get(band)

        s_raw = strain_by_date[dt]
        deep, light, rem, awake = r["deep_s"], r["light_s"], r["rem_s"], r["awake_s"]
        total_stage = (deep or 0) + (light or 0) + (rem or 0) + (awake or 0)

        computed[dt] = {
            "date": dt, "hrv": r["hrv"], "hrv_baseline": r["hrv_baseline"], "rhr": r["rhr"],
            "respiration": r["respiration"], "spo2": r["spo2"],
            "skin_temp_dev_c": r["skin_temp_dev_c"], "stress_avg": r["stress_avg"], "steps": r["steps"],
            "slept_h": slept_h, "deep_s": deep, "light_s": light, "rem_s": rem, "awake_s": awake,
            "deep_pct": (deep / total_stage * 100) if deep is not None and total_stage else None,
            "rem_pct": (rem / total_stage * 100) if rem is not None and total_stage else None,
            "light_pct": (light / total_stage * 100) if light is not None and total_stage else None,
            "awake_pct": (awake / total_stage * 100) if awake is not None and total_stage else None,
            "time_in_bed_h": ((r["sleep_end_gmt"] - r["sleep_start_gmt"]) / 3600000)
                if r["sleep_start_gmt"] and r["sleep_end_gmt"] else None,
            "sleep_need": need_info, "sleep_performance_pct": sleep_perf_pct,
            "activities": activities_by_date.get(dt, []),
            "day_load": day_load(dt), "strain_raw": s_raw, "strain_clamped": min(s_raw, 21.0),
            "recovery_scores": scores, "recovery_weights_used": used_weights,
            "recovery": recovery, "recovery_band": band, "target_strain": target_strain,
        }

    deep_pcts = [computed[dt]["deep_pct"] for dt in dates if computed[dt]["deep_pct"] is not None]
    rem_pcts = [computed[dt]["rem_pct"] for dt in dates if computed[dt]["rem_pct"] is not None]

    # Step 7 check #1: reconcile stage totals vs dailySleepDTO on 3 nights
    import random
    rng = random.Random(42)
    candidates = [dt for dt in dates if computed[dt]["deep_s"] is not None]
    sample_nights = rng.sample(candidates, min(3, len(candidates)))
    reconciliation = []
    for dt in sample_nights:
        dto = (days[dt].get("sleep") or {}).get("dailySleepDTO") or {}
        levels = (days[dt].get("sleep") or {}).get("sleepLevels") or []
        from datetime import datetime as _dt
        sums = {}
        for seg in levels:
            code = seg["activityLevel"]
            s = _dt.strptime(seg["startGMT"], "%Y-%m-%dT%H:%M:%S.%f")
            e = _dt.strptime(seg["endGMT"], "%Y-%m-%dT%H:%M:%S.%f")
            sums[code] = sums.get(code, 0) + (e - s).total_seconds()
        diffs = {
            "deep": sums.get(0.0, 0) - (dto.get("deepSleepSeconds") or 0),
            "light": sums.get(1.0, 0) - (dto.get("lightSleepSeconds") or 0),
            "rem": sums.get(2.0, 0) - (dto.get("remSleepSeconds") or 0),
            "awake": sums.get(3.0, 0) - (dto.get("awakeSleepSeconds") or 0),
        }
        reconciliation.append({"date": dt, "max_abs_diff_s": max(abs(v) for v in diffs.values())})

    honesty = {
        "deep_pct_range": [min(deep_pcts), max(deep_pcts)] if deep_pcts else None,
        "rem_pct_range": [min(rem_pcts), max(rem_pcts)] if rem_pcts else None,
        "no_hr_activities": no_hr_activities,
        "total_nights_with_stages": len(deep_pcts),
        "reconciliation": reconciliation,
    }

    return {
        "dates": dates, "days": computed, "baselines": baselines,
        "honesty": honesty, "synced_at": data.get("synced_at"),
    }


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wellness</title>
<style>
  :root{
    --bg:#0b0d10; --panel:#15181c; --panel2:#1c2025; --border:#262b31;
    --text:#e8ebee; --muted:#8b94a0; --accent:#4da3ff;
    --green:#3ecf8e; --yellow:#e8c547; --red:#e8546a;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
  header{position:sticky;top:0;background:var(--bg);z-index:10;padding:14px 16px 0;border-bottom:1px solid var(--border);}
  h1{font-size:15px;font-weight:600;color:var(--muted);margin:0 0 12px;text-transform:uppercase;letter-spacing:.06em;}
  nav{display:flex;gap:4px;}
  nav button{flex:1;background:none;border:none;color:var(--muted);padding:10px 0 12px;font-size:14px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;}
  nav button.active{color:var(--text);border-bottom-color:var(--accent);}
  main{padding:16px;max-width:480px;margin:0 auto;padding-bottom:60px;}
  .view{display:none;} .view.active{display:block;}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px;}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:600;}
  .ring-wrap{display:flex;flex-direction:column;align-items:center;padding:8px 0 4px;}
  .ring-label{font-size:13px;color:var(--muted);margin-top:8px;text-transform:uppercase;letter-spacing:.05em;}
  .band-pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-top:6px;}
  .band-green{background:rgba(62,207,142,.15);color:var(--green);}
  .band-yellow{background:rgba(232,197,71,.15);color:var(--yellow);}
  .band-red{background:rgba(232,84,106,.15);color:var(--red);}
  table.inputs{width:100%;border-collapse:collapse;font-size:13px;}
  table.inputs th{text-align:left;color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;padding:6px 4px;border-bottom:1px solid var(--border);}
  table.inputs td{padding:8px 4px;border-bottom:1px solid var(--border);}
  table.inputs tr:last-child td{border-bottom:none;}
  .strip{display:flex;gap:6px;align-items:flex-end;height:60px;}
  .strip .bar{flex:1;border-radius:4px 4px 2px 2px;min-height:4px;position:relative;}
  .strip .bar-label{font-size:9px;color:var(--muted);text-align:center;margin-top:4px;}
  .strip-col{display:flex;flex-direction:column;flex:1;align-items:center;justify-content:flex-end;height:100%;}
  .big-num{font-size:44px;font-weight:700;line-height:1;}
  .sub{color:var(--muted);font-size:13px;margin-top:4px;}
  .readout{font-size:14px;line-height:1.5;color:var(--text);}
  .target-track{position:relative;height:10px;background:var(--panel2);border-radius:6px;margin:14px 0 6px;}
  .target-band{position:absolute;top:0;bottom:0;background:rgba(77,163,255,.25);border-radius:6px;}
  .target-marker{position:absolute;top:-4px;width:3px;height:18px;background:var(--text);border-radius:2px;}
  .scale-labels{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);}
  .act-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;}
  .act-row:last-child{border-bottom:none;}
  .act-name{font-weight:600;}
  .act-meta{color:var(--muted);font-size:11px;margin-top:2px;}
  .stagebar{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:10px 0;}
  .legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--muted);margin-top:6px;}
  .legend span{display:inline-flex;align-items:center;gap:4px;}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
  .need-line{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px dashed var(--border);}
  .need-line:last-child{border-bottom:none;font-weight:700;padding-top:10px;}
  details{margin-top:4px;}
  summary{cursor:pointer;color:var(--accent);font-size:13px;font-weight:600;padding:6px 0;}
  pre{background:var(--panel2);border-radius:8px;padding:10px;font-size:11px;overflow-x:auto;color:#c9d1d9;line-height:1.5;}
  .flag{font-size:12px;color:var(--yellow);background:rgba(232,197,71,.1);border-radius:8px;padding:8px 10px;margin-top:8px;}
  .muted{color:var(--muted);}
  .footer-note{font-size:11px;color:var(--muted);text-align:center;margin-top:20px;}
</style>
</head>
<body>
<header>
  <h1>Wellness &middot; synced __SYNCED_AT__</h1>
  <nav>
    <button class="tab active" data-view="recovery">Recovery</button>
    <button class="tab" data-view="strain">Strain</button>
    <button class="tab" data-view="sleep">Sleep</button>
  </nav>
</header>
<main>

<section id="view-recovery" class="view active"></section>
<section id="view-strain" class="view"></section>
<section id="view-sleep" class="view"></section>

<div class="card">
  <details>
    <summary>How this is calculated</summary>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">
      Baseline sample sizes &mdash; HRV: <b id="n-hrv"></b> nights,
      RHR: <b id="n-rhr30"></b>/30d &amp; <b id="n-rhr14"></b>/14d,
      Sleep: <b id="n-sleep"></b> nights.
      Deep sleep ranged <b id="deep-range"></b> of total sleep across all nights;
      REM ranged <b id="rem-range"></b>. That spread is the honest picture of how much
      sleep staging is inference on a wrist device, not measurement.
    </div>
    <pre id="formulas-pre"></pre>
  </details>
</div>

<div class="footer-note">Every number above traces to a field in data.json or the formulas shown here. Nothing is invented.</div>
</main>

<script>
const DATA = __DASHBOARD_DATA_JSON__;

const dates = DATA.dates;
const days = DATA.days;
const today = dates[dates.length - 1];
const last7 = dates.slice(-7);
const bandColor = {green:'var(--green)', yellow:'var(--yellow)', red:'var(--red)'};

function fmt(x, d=1){ return (x===null||x===undefined||isNaN(x)) ? '&mdash;' : Number(x).toFixed(d); }
function hm(hours){
  if(hours===null||hours===undefined) return '&mdash;';
  const h = Math.floor(hours); const m = Math.round((hours-h)*60);
  return h+'h '+String(m).padStart(2,'0')+'m';
}

function ring(pct, color){
  const r=52, c=2*Math.PI*r;
  const off = c*(1-Math.max(0,Math.min(100,pct))/100);
  return '<svg width="160" height="160" viewBox="0 0 140 140">'
    +'<circle cx="70" cy="70" r="'+r+'" stroke="var(--panel2)" stroke-width="12" fill="none"/>'
    +'<circle cx="70" cy="70" r="'+r+'" stroke="'+color+'" stroke-width="12" fill="none" stroke-linecap="round" '
    +'stroke-dasharray="'+c+'" stroke-dashoffset="'+off+'" transform="rotate(-90 70 70)"/>'
    +'<text x="70" y="78" text-anchor="middle" font-size="34" font-weight="700" fill="var(--text)">'+Math.round(pct)+'%</text>'
    +'</svg>';
}

function renderRecovery(){
  const d = days[today];
  const el = document.getElementById('view-recovery');
  if(d.recovery===null){ el.innerHTML = '<div class="card">No recovery data for '+today+'</div>'; return; }
  const color = bandColor[d.recovery_band];

  let rows = '';
  const hrvB = DATA.baselines.hrv, rhrB = DATA.baselines.rhr_30;
  if(d.hrv!==null && d.recovery_weights_used.hrv){
    const z = ((d.hrv - hrvB.mean)/hrvB.sd);
    rows += '<tr><td>HRV</td><td>'+fmt(d.hrv,0)+' ms</td><td>'+fmt(hrvB.mean,1)+'&plusmn;'+fmt(hrvB.sd,1)+'</td><td>'+(z>=0?'+':'')+fmt(z,2)+'&sigma;</td><td>'+Math.round(d.recovery_weights_used.hrv*100)+'%</td></tr>';
  }
  if(d.rhr!==null && d.recovery_weights_used.rhr){
    const z = ((d.rhr - rhrB.mean)/rhrB.sd);
    rows += '<tr><td>RHR</td><td>'+fmt(d.rhr,0)+' bpm</td><td>'+fmt(rhrB.mean,1)+'&plusmn;'+fmt(rhrB.sd,1)+'</td><td>'+(z>=0?'+':'')+fmt(z,2)+'&sigma;</td><td>'+Math.round(d.recovery_weights_used.rhr*100)+'%</td></tr>';
  }
  if(d.sleep_performance_pct!==null && d.recovery_weights_used.sleep){
    rows += '<tr><td>Sleep</td><td>'+hm(d.slept_h)+'</td><td>need '+hm(d.sleep_need.need_h)+'</td><td>'+fmt(d.sleep_performance_pct,0)+'%</td><td>'+Math.round(d.recovery_weights_used.sleep*100)+'%</td></tr>';
  }

  let strip = '';
  last7.forEach(dt=>{
    const dd = days[dt];
    const h = dd.recovery!==null ? Math.max(6, dd.recovery) : 6;
    const c = dd.recovery!==null ? bandColor[dd.recovery_band] : 'var(--border)';
    strip += '<div class="strip-col"><div class="bar" style="height:'+h+'%;width:70%;background:'+c+'"></div>'
      +'<div class="bar-label">'+dt.slice(5)+'</div></div>';
  });

  const readout = {
    green: "Fully recovered. This is a green light for a hard session &mdash; your target strain band is 14.0&ndash;18.0.",
    yellow: "Partially recovered. Moderate load is appropriate today &mdash; target strain 9.0&ndash;13.5. Save the all-out effort for a greener day.",
    red: "Poorly recovered. Keep today light &mdash; target strain 0&ndash;8.0. Pushing hard now digs the hole deeper, not shallower."
  }[d.recovery_band];

  el.innerHTML =
    '<div class="card"><h2>Today &middot; '+today+'</h2>'
    +'<div class="ring-wrap">'+ring(d.recovery,color)
    +'<div class="band-pill band-'+d.recovery_band+'">'+d.recovery_band+'</div></div>'
    +'<div class="readout" style="margin-top:10px">'+readout+'</div></div>'
    +'<div class="card"><h2>Inputs</h2><table class="inputs"><thead><tr><th>Metric</th><th>Value</th><th>Baseline</th><th>Deviation</th><th>Weight</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    +'<div class="card"><h2>7-day history</h2><div class="strip">'+strip+'</div></div>';
}

function renderStrain(){
  const d = days[today];
  const el = document.getElementById('view-strain');
  const target = d.target_strain;
  const strainPct = (d.strain_clamped/21*100);

  let flag = '';
  if(d.strain_raw > 21){
    flag = '<div class="flag">Raw strain came out to '+fmt(d.strain_raw,1)+' &mdash; above the 0&ndash;21 scale ceiling (the formula is only calibrated to hit 21 at day_load=90). Displayed as '+fmt(d.strain_clamped,1)+', capped.</div>';
  }

  let track = '';
  if(target){
    const left = target[0]/21*100, width=(target[1]-target[0])/21*100;
    track = '<div class="target-track"><div class="target-band" style="left:'+left+'%;width:'+width+'%"></div>'
      +'<div class="target-marker" style="left:'+strainPct+'%;background:'+bandColor[d.recovery_band]+'"></div></div>'
      +'<div class="scale-labels"><span>0</span><span>21</span></div>'
      +'<div class="sub">Target '+fmt(target[0],1)+'&ndash;'+fmt(target[1],1)+' (from this morning\'s '+d.recovery_band+' recovery)</div>';
  }

  let strip = '';
  last7.forEach(dt=>{
    const dd = days[dt];
    const h = Math.max(4, dd.strain_clamped/21*100);
    let c = '#4da3ff';
    if(dd.strain_clamped>=18) c='var(--red)'; else if(dd.strain_clamped>=14) c='#e88a3f'; else if(dd.strain_clamped>=10) c='var(--yellow)'; else c='var(--green)';
    strip += '<div class="strip-col"><div class="bar" style="height:'+h+'%;width:70%;background:'+c+'"></div>'
      +'<div class="bar-label">'+dt.slice(5)+'</div></div>';
  });

  let acts = '';
  const recentDates = dates.slice(-14).reverse();
  let any = false;
  recentDates.forEach(dt=>{
    (days[dt].activities||[]).forEach(a=>{
      any = true;
      const durMin = a.duration_s ? Math.round(a.duration_s/60) : null;
      acts += '<div class="act-row"><div><div class="act-name">'+(a.name||a.type||'Activity')+'</div>'
        +'<div class="act-meta">'+dt+' &middot; '+(durMin!==null?durMin+' min':'&mdash;')+' &middot; avg HR '+(a.avg_hr!==null?Math.round(a.avg_hr):'&mdash;')+'</div></div>'
        +'<div style="text-align:right;font-weight:700">'+fmt(a.load,1)+'<div class="act-meta">load</div></div></div>';
    });
  });
  if(!any) acts = '<div class="muted" style="font-size:13px">No activities in the last 14 days.</div>';

  el.innerHTML =
    '<div class="card"><h2>Today &middot; '+today+'</h2>'
    +'<div class="big-num">'+fmt(d.strain_clamped,1)+'<span style="font-size:16px;color:var(--muted)"> / 21</span></div>'
    +'<div class="sub">day_load = '+fmt(d.day_load,1)+' (incl. 4.0 non-exercise baseline)</div>'
    +flag+track+'</div>'
    +'<div class="card"><h2>7-day strain</h2><div class="strip">'+strip+'</div>'
    +'<div class="legend"><span><i class="dot" style="background:var(--green)"></i>light 0-9</span>'
    +'<span><i class="dot" style="background:var(--yellow)"></i>moderate 10-13</span>'
    +'<span><i class="dot" style="background:#e88a3f"></i>high 14-17</span>'
    +'<span><i class="dot" style="background:var(--red)"></i>all out 18-21</span></div></div>'
    +'<div class="card"><h2>Recent activities</h2>'+acts+'</div>';
}

function renderSleep(){
  const d = days[today];
  const el = document.getElementById('view-sleep');
  if(d.slept_h===null){ el.innerHTML='<div class="card">No sleep data for '+today+'</div>'; return; }

  const pct = d.sleep_performance_pct;
  const color = pct>=90?'var(--green)':(pct>=75?'var(--yellow)':'var(--red)');

  const need = d.sleep_need;
  const needLines =
    '<div class="need-line"><span>Baseline</span><span>'+hm(need.baseline_h)+'</span></div>'
    +'<div class="need-line"><span>+ Strain adjustment (yesterday strain '+fmt(need.yesterday_strain,1)+')</span><span>'+hm(need.f_strain_h)+'</span></div>'
    +'<div class="need-line"><span>+ Sleep debt (last '+need.nights_used_for_debt+' nights, capped 1.5h)</span><span>'+hm(need.debt_h)+'</span></div>'
    +'<div class="need-line"><span>&minus; Naps</span><span>'+hm(need.naps_h)+'</span></div>'
    +'<div class="need-line"><span>Sleep need</span><span>'+hm(need.need_h)+'</span></div>';

  const stages = [
    {k:'deep', label:'Deep', pct:d.deep_pct, s:d.deep_s, color:'#2d5fb0'},
    {k:'light', label:'Light', pct:d.light_pct, s:d.light_s, color:'#4da3ff'},
    {k:'rem', label:'REM', pct:d.rem_pct, s:d.rem_s, color:'#9b7fe0'},
    {k:'awake', label:'Awake', pct:d.awake_pct, s:d.awake_s, color:'#e8546a'},
  ];
  let stagebar = '<div class="stagebar">';
  stages.forEach(st=>{ if(st.pct) stagebar += '<div style="width:'+st.pct+'%;background:'+st.color+'"></div>'; });
  stagebar += '</div>';
  let legend = '<div class="legend">';
  stages.forEach(st=>{ legend += '<span><i class="dot" style="background:'+st.color+'"></i>'+st.label+' '+fmt(st.pct,0)+'% ('+hm((st.s||0)/3600)+')</span>'; });
  legend += '</div>';

  const efficiency = d.time_in_bed_h ? (d.slept_h/d.time_in_bed_h*100) : null;

  let strip = '';
  last7.forEach(dt=>{
    const dd = days[dt];
    const p = dd.sleep_performance_pct;
    const h = p!==null ? Math.max(6, Math.min(100,p)) : 6;
    const c = p===null ? 'var(--border)' : (p>=90?'var(--green)':(p>=75?'var(--yellow)':'var(--red)'));
    strip += '<div class="strip-col"><div class="bar" style="height:'+h+'%;width:70%;background:'+c+'"></div>'
      +'<div class="bar-label">'+dt.slice(5)+'</div></div>';
  });

  el.innerHTML =
    '<div class="card"><h2>Last night &middot; '+today+'</h2>'
    +'<div class="ring-wrap">'+ring(Math.min(100,pct),color)+'<div class="sub">of need &mdash; '+fmt(pct,0)+'% actual'+(pct>100?' (slept more than needed)':'')+'</div></div></div>'
    +'<div class="card"><h2>Where the need number came from</h2>'+needLines+'</div>'
    +'<div class="card"><h2>Sleep stages</h2>'+stagebar+legend+'</div>'
    +'<div class="card"><h2>Time in bed vs asleep</h2>'
    +'<table class="inputs"><tbody>'
    +'<tr><td>Time in bed</td><td>'+hm(d.time_in_bed_h)+'</td></tr>'
    +'<tr><td>Time asleep</td><td>'+hm(d.slept_h)+'</td></tr>'
    +'<tr><td>Efficiency</td><td>'+fmt(efficiency,0)+'%</td></tr>'
    +'</tbody></table></div>'
    +'<div class="card"><h2>7-night history</h2><div class="strip">'+strip+'</div></div>';
}

function renderFormulas(){
  document.getElementById('n-hrv').textContent = DATA.baselines.hrv.n;
  document.getElementById('n-rhr30').textContent = DATA.baselines.rhr_30.n;
  document.getElementById('n-rhr14').textContent = DATA.baselines.rhr_14.n;
  document.getElementById('n-sleep').textContent = DATA.baselines.sleep.n;
  const dr = DATA.honesty.deep_pct_range, rr = DATA.honesty.rem_pct_range;
  document.getElementById('deep-range').textContent = dr ? dr[0].toFixed(1)+'%–'+dr[1].toFixed(1)+'%' : 'n/a';
  document.getElementById('rem-range').textContent = rr ? rr[0].toFixed(1)+'%–'+rr[1].toFixed(1)+'%' : 'n/a';
  document.getElementById('formulas-pre').textContent =
`RECOVERY (0-100%)
hrv_z = (last_night_hrv - hrv_mean) / hrv_sd
rhr_z = (today_rhr - rhr_mean) / rhr_sd
hrv_score   = clamp(50 + 20*hrv_z, 0, 100)
rhr_score   = clamp(50 - 20*rhr_z, 0, 100)
sleep_score = min(100, sleep_performance_pct)
recovery = 0.50*hrv_score + 0.25*rhr_score + 0.25*sleep_score
Bands: 67-100 green, 34-66 yellow, 0-33 red.
Missing input -> its weight is redistributed proportionally to the rest.

STRAIN (0-21, logarithmic)
day_load = sum(activityTrainingLoad per activity that day) + 4.0
strain = 21 * ln(1 + day_load/12) / ln(1 + 90/12)
Bands: 0-9 light, 10-13 moderate, 14-17 high, 18-21 all out.
Note: day_load > 90 pushes the raw formula above 21; displayed value is capped at 21.

SLEEP NEED
sleep_need = baseline(8h) + f(yesterday_strain) + debt - naps
f(strain) = 1.7 / (1 + e^((17-strain)/3.5))  hours
debt = min(0.35 * sum(shortfall vs baseline, prior 3 nights), 1.5h)
sleep_performance = slept / sleep_need

STRAIN TARGET FROM RECOVERY
green (67-100%)  -> target strain 14.0-18.0
yellow (34-66%)  -> target strain 9.0-13.5
red (0-33%)      -> target strain 0-8.0`;
}

document.querySelectorAll('nav .tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('nav .tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-'+btn.dataset.view).classList.add('active');
  });
});

renderRecovery();
renderStrain();
renderSleep();
renderFormulas();
</script>
</body>
</html>
"""


def render(computed):
    html = HTML_TEMPLATE.replace("__DASHBOARD_DATA_JSON__", json.dumps(computed, default=str, separators=(",", ":")))
    html = html.replace("__SYNCED_AT__", str(computed.get("synced_at") or computed["dates"][-1]))
    return html


def main():
    data_path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent / "data.json")
    out_path = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).parent / "dashboard.html")
    data = load(data_path)
    computed = build(data)
    html = render(computed)
    with open(out_path, "w") as f:
        f.write(html)
    print(f"Wrote {out_path} ({len(html)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
