// Berechnet Recovery, Strain und Sleep aus den Garmin-Rohdaten.
// Formeln übernommen aus garmin/build_dashboard.py (Recovery: HRV 50 %,
// Ruhepuls 25 %, Schlafleistung 25 %; Strain: logarithmisch 0–21 aus
// Garmins Trainingsbelastung). Schlafbedarf bevorzugt Garmins eigenen Wert.

const BASELINE_SLEEP_HOURS = 8.0;
const MIN_BASELINE_DAYS = 5;

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

export function strainFromLoad(load) {
  return Math.min(21, (21 * Math.log(1 + load / 12)) / Math.log(1 + 90 / 12));
}

export function recoveryBand(r) {
  if (r == null) return null;
  return r >= 67 ? "green" : r >= 34 ? "yellow" : "red";
}

const TARGET_STRAIN = { green: [14.0, 18.0], yellow: [9.0, 13.5], red: [0.0, 8.0] };

// Garmins sleepNeed.actual: Einheit in der Doku nicht angegeben. Plausible
// Minutenwerte (3–15 h) werden übernommen, Sekunden umgerechnet, sonst null.
function sleepNeedHours(dto) {
  const v = num(dto && dto.sleepNeed && dto.sleepNeed.actual);
  if (v == null) return null;
  if (v >= 180 && v <= 900) return v / 60;
  if (v >= 10800 && v <= 54000) return v / 3600;
  return null;
}

function activityType(a) {
  const t = a.activityType;
  return t && typeof t === "object" ? t.typeKey || null : t || null;
}

export function summarizeActivity(a) {
  const load = num(a.activityTrainingLoad) || 0;
  return {
    id: a.activityId,
    name: a.activityName || "Aktivität",
    type: activityType(a),
    start: a.startTimeLocal || null,
    date: (a.startTimeLocal || "").slice(0, 10),
    durationS: num(a.duration),
    movingS: num(a.movingDuration),
    distanceM: num(a.distance),
    avgSpeed: num(a.averageSpeed),
    avgHR: num(a.averageHR),
    maxHR: num(a.maxHR),
    calories: num(a.calories),
    elevationGain: num(a.elevationGain),
    load,
    strain: strainFromLoad(load),
    aerobicTE: num(a.aerobicTrainingEffect),
    anaerobicTE: num(a.anaerobicTrainingEffect),
    teLabel: a.trainingEffectLabel || null,
    zones: [1, 2, 3, 4, 5].map((z) => num(a["hrTimeInZone_" + z]) || 0),
    sets: num(a.totalSets),
    reps: num(a.totalReps),
    cadence: num(a.averageRunningCadenceInStepsPerMinute),
  };
}

// raw: { activities: [], hrv: {hrvSummaries: []}, sleep: [], summaries: {data: []} }
export function buildDay(D, raw, windowDays = 30) {
  const warnings = [];
  const from = addDays(D, -windowDays);
  const dates = [];
  for (let d = from; d <= D; d = addDays(d, 1)) dates.push(d);

  const hrvBy = {};
  for (const h of (raw.hrv && raw.hrv.hrvSummaries) || []) if (h && h.calendarDate) hrvBy[h.calendarDate] = h;
  const sleepBy = {};
  for (const s of raw.sleep || []) if (s && s.calendarDate) sleepBy[s.calendarDate] = s;
  const sumBy = {};
  for (const s of (raw.summaries && raw.summaries.data) || []) if (s && s.calendarDate) sumBy[s.calendarDate] = s;

  const acts = (raw.activities || []).map(summarizeActivity).sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  const actsBy = {};
  for (const a of acts) (actsBy[a.date] = actsBy[a.date] || []).push(a);

  const hrvOf = (d) => num(hrvBy[d] && hrvBy[d].lastNightAvg);
  const rhrOf = (d) => num(sumBy[d] && sumBy[d].heartRate && sumBy[d].heartRate.restingValue);
  const sleepSecOf = (d) => num(sleepBy[d] && sleepBy[d].sleepTimeSeconds);

  const zoneSum = (d, zs) => (actsBy[d] || []).reduce((s, a) => s + zs.reduce((t, z) => t + a.zones[z], 0), 0);
  const strengthOf = (d) => (actsBy[d] || []).filter((a) => /strength/i.test(a.type || "")).reduce((s, a) => s + (a.durationS || 0), 0);
  // Minuten seit 12:00 mittags, damit Zeiten um Mitternacht vergleichbar sind
  const clockMin = (ts) => { const m = /T?(\d{2}):(\d{2})/.exec((ts || "").slice(10)); return m ? (Number(m[1]) * 60 + Number(m[2]) + 720) % 1440 : null; };

  const dayLoad = (d) => (actsBy[d] || []).reduce((s, a) => s + a.load, 0) + 4.0;
  const strainOf = (d) => (d in sumBy || d in actsBy || d === D ? strainFromLoad(dayLoad(d)) : null);

  function sleepNeed(d) {
    const garmin = sleepNeedHours(sleepBy[d]);
    if (garmin != null) return { hours: garmin, source: "garmin" };
    const ys = strainOf(addDays(d, -1));
    const fStrain = ys != null ? 1.7 / (1 + Math.exp((17 - ys) / 3.5)) : 0;
    const shortfalls = [1, 2, 3].map((k) => sleepSecOf(addDays(d, -k))).filter((v) => v != null)
      .map((s) => Math.max(0, BASELINE_SLEEP_HOURS - s / 3600));
    const debt = Math.min(0.35 * shortfalls.reduce((s, v) => s + v, 0), 1.5);
    const naps = (num(sleepBy[d] && sleepBy[d].napTimeSeconds) || 0) / 3600;
    return { hours: BASELINE_SLEEP_HOURS + fStrain + debt - naps, source: "formel" };
  }

  function sleepPerf(d) {
    const s = sleepSecOf(d);
    if (s == null || s < 1800) return null;
    return clamp((s / 3600 / sleepNeed(d).hours) * 100, 0, 100);
  }

  // Baseline aus den Tagen vor d (im Fenster); zu wenige → Garmins HRV-Baseline.
  function hrvBaseline(d) {
    const vals = dates.filter((x) => x < d).map(hrvOf).filter((v) => v != null);
    if (vals.length >= MIN_BASELINE_DAYS && sd(vals) > 0) return { mean: mean(vals), sd: sd(vals), n: vals.length, source: "eigene" };
    const b = hrvBy[d] && hrvBy[d].baseline;
    if (b && num(b.balancedLow) != null && num(b.balancedUpper) != null && b.balancedUpper > b.balancedLow) {
      return { mean: (b.balancedLow + b.balancedUpper) / 2, sd: (b.balancedUpper - b.balancedLow) / 2, n: vals.length, source: "garmin" };
    }
    return null;
  }
  function rhrBaseline(d) {
    const vals = dates.filter((x) => x < d).map(rhrOf).filter((v) => v != null);
    if (vals.length >= MIN_BASELINE_DAYS && sd(vals) > 0) return { mean: mean(vals), sd: sd(vals), n: vals.length };
    return null;
  }

  function recovery(d) {
    // Recovery erst, wenn die Nacht zu Tag d bei Garmin angekommen ist.
    if (sleepSecOf(d) == null) return null;
    const weights = { hrv: 0.5, rhr: 0.25, sleep: 0.25 };
    const parts = {};
    const hb = hrvBaseline(d), h = hrvOf(d);
    if (h != null && hb) parts.hrv = clamp(50 + 20 * ((h - hb.mean) / hb.sd), 0, 100);
    const rb = rhrBaseline(d), r = rhrOf(d);
    if (r != null && rb) parts.rhr = clamp(50 - 20 * ((r - rb.mean) / rb.sd), 0, 100);
    const sp = sleepPerf(d);
    if (sp != null) parts.sleep = sp;
    const w = Object.keys(parts).reduce((s, k) => s + weights[k], 0);
    if (!w) return null;
    const score = Object.keys(parts).reduce((s, k) => s + (weights[k] / w) * parts[k], 0);
    return { score, parts, weights: Object.fromEntries(Object.keys(parts).map((k) => [k, weights[k] / w])), hrvBaseline: hb, rhrBaseline: rb };
  }

  // Tageswerte für D
  const sDto = sleepBy[D] || null;
  const rec = recovery(D);
  if (!sDto) warnings.push("Noch keine Schlafdaten für diesen Tag – Uhr mit Garmin Connect synchronisieren.");
  if (rec && rec.hrvBaseline && rec.hrvBaseline.source === "garmin") warnings.push("HRV-Baseline aus Garmin (weniger als 5 eigene Tage).");
  if (rec && !rec.parts.hrv) warnings.push("Keine HRV für diese Nacht – Recovery ohne HRV berechnet.");

  const need = sleepNeed(D);
  const scoreItem = sDto && sDto.sleepScores && sDto.sleepScores.overall;
  const sleep = sDto ? {
    performance: sleepPerf(D),
    hours: sleepSecOf(D) != null ? sleepSecOf(D) / 3600 : null,
    needHours: need.hours,
    needSource: need.source,
    garminScore: scoreItem ? num(scoreItem.value) : null,
    garminQualifier: scoreItem ? scoreItem.qualifierKey || null : null,
    deepS: num(sDto.deepSleepSeconds), lightS: num(sDto.lightSleepSeconds),
    remS: num(sDto.remSleepSeconds), awakeS: num(sDto.awakeSleepSeconds),
    start: sDto.sleepStartTimestampLocal || null, end: sDto.sleepEndTimestampLocal || null,
    respiration: num(sDto.averageRespirationValue),
    avgHR: num(sDto.avgHeartRate),
    spo2: num(sDto.averageSpO2Value),
    awakeCount: num(sDto.awakeCount),
    napS: num(sDto.napTimeSeconds),
  } : null;

  // Schlafregelmäßigkeit (Annäherung): Abweichung von Einschlaf- und Aufwachzeit
  // gegenüber dem Schnitt der 4 Nächte davor. 30 min → 76 %, 60 min → 52 %.
  function regularity(d) {
    const s0 = sleepBy[d]; if (!s0) return null;
    const cur = [clockMin(s0.sleepStartTimestampLocal), clockMin(s0.sleepEndTimestampLocal)];
    if (cur.some((v) => v == null)) return null;
    const prev = [1, 2, 3, 4].map((k) => sleepBy[addDays(d, -k)]).filter(Boolean)
      .map((x) => [clockMin(x.sleepStartTimestampLocal), clockMin(x.sleepEndTimestampLocal)]).filter((x) => x.every((v) => v != null));
    if (prev.length < 2) return null;
    const dev = [0, 1].map((i) => Math.abs(cur[i] - mean(prev.map((x) => x[i])))).reduce((a, b) => a + b, 0) / 2;
    return clamp(100 - dev * 0.8, 0, 100);
  }
  if (sleep) {
    const tot = (sleep.deepS || 0) + (sleep.lightS || 0) + (sleep.remS || 0);
    sleep.efficiency = tot + (sleep.awakeS || 0) > 0 ? (tot / (tot + (sleep.awakeS || 0))) * 100 : null;
    sleep.regularity = regularity(D);
    sleep.stress = num(sDto.avgSleepStress);
  }

  const band = rec ? recoveryBand(rec.score) : null;
  const strainScore = strainOf(D);

  // Schlüsselwerte mit 30-Tage-Schnitt (ohne Tag D)
  const prior = dates.filter((d) => d < D);
  const stat = (fn) => {
    const v = fn(D);
    const vals = prior.map(fn).filter((x) => x != null);
    return { value: v, avg30: vals.length ? mean(vals) : null };
  };
  const sumField = (pathFn) => (d) => { try { return num(pathFn(sumBy[d])); } catch { return null; } };
  const stats = {
    hrv: stat(hrvOf),
    rhr: stat(rhrOf),
    respiration: stat((d) => num(sleepBy[d] && sleepBy[d].averageRespirationValue)),
    sleepHours: stat((d) => (sleepSecOf(d) != null ? sleepSecOf(d) / 3600 : null)),
    steps: stat(sumField((s) => s.movement.steps.value)),
    calories: stat(sumField((s) => s.calories.burnedTotal)),
    bodyBattery: stat(sumField((s) => s.bodyBattery.maxValue)),
    stress: stat(sumField((s) => s.stress.avgLevel)),
    zones13: stat((d) => zoneSum(d, [0, 1, 2])),
    zones45: stat((d) => zoneSum(d, [3, 4])),
    strengthS: stat(strengthOf),
    sleepPerf: stat(sleepPerf),
  };

  const history = dates.map((d) => {
    const r = recovery(d);
    return { date: d, recovery: r ? r.score : null, band: r ? recoveryBand(r.score) : null, sleepPerf: sleepPerf(d), strain: strainOf(d), sleepHours: sleepSecOf(d) != null ? sleepSecOf(d) / 3600 : null };
  });

  return {
    date: D,
    recovery: rec ? {
      score: rec.score, band, parts: rec.parts, weights: rec.weights,
      hrv: hrvOf(D), hrvBaseline: rec.hrvBaseline && rec.hrvBaseline.mean, hrvBaselineSource: rec.hrvBaseline && rec.hrvBaseline.source,
      hrvStatus: (hrvBy[D] && hrvBy[D].status) || null,
      rhr: rhrOf(D), rhrBaseline: rec.rhrBaseline && rec.rhrBaseline.mean,
    } : null,
    strain: { score: strainScore, load: dayLoad(D), target: band ? TARGET_STRAIN[band] : null, activities: actsBy[D] || [] },
    sleep,
    stats,
    history,
    activities: acts,
    warnings,
  };
}
