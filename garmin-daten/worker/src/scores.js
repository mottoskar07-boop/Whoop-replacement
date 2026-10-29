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

// Garmin liefert "...Local"-Zeitstempel je nach Endpunkt als Text oder als
// Millisekunden-Zahl (auf Ortszeit verschoben). Einheitlich: "YYYY-MM-DDTHH:MM:SS".
export function localTs(ts) {
  if (typeof ts === "number" && isFinite(ts)) return new Date(ts).toISOString().slice(0, 19);
  if (typeof ts === "string" && ts.length >= 16) return ts.replace(" ", "T").slice(0, 19);
  return null;
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
    start: localTs(a.startTimeLocal),
    date: (localTs(a.startTimeLocal) || "").slice(0, 10),
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
  const clockMin = (ts) => { const t = localTs(ts); return t ? (Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) + 720) % 1440 : null; };

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

  function garminSleepScore(d) {
    const o = sleepBy[d] && sleepBy[d].sleepScores && sleepBy[d].sleepScores.overall;
    return o ? num(o.value) : null;
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
    // Schlafanteil: Garmins Sleep Score (Dauer + Qualität); fehlt er, Schlafleistung (Dauer / Bedarf)
    const gs = garminSleepScore(d), sp = sleepPerf(d);
    if (gs != null) parts.sleep = gs; else if (sp != null) parts.sleep = sp;
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
    start: localTs(sDto.sleepStartTimestampLocal), end: localTs(sDto.sleepEndTimestampLocal),
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
    sleepScore: stat(garminSleepScore),
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

// ---------- Stress-Monitor ----------
// Garmins Personal API liefert keinen Stressverlauf, nur Tagessummen. Deshalb
// eine Annäherung an Whoops 0–3-Skala aus dem Pulsverlauf: je 15 bpm über dem
// Ruhepuls ein Punkt (0 = Ruhepuls, 3 = 45+ bpm darüber), in 5-Minuten-Blöcken.
// Zeiten in Aktivitäten werden markiert und nicht als Stress gewertet.
const STRESS_BPM_PER_POINT = 15;
const BUCKET_MS = 5 * 60 * 1000;

function gmtMs(ts) {
  if (typeof ts === "number" && isFinite(ts)) return ts;
  if (typeof ts === "string" && ts.length >= 16) {
    const s = ts.replace(" ", "T");
    return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
  }
  return null;
}

export function buildStress(hrDto, sleepDto, activitiesRaw, rhr) {
  if (!hrDto || !Array.isArray(hrDto.heartRateValues) || !hrDto.heartRateValues.length) return null;
  const desc = {};
  for (const d of hrDto.heartRateValueDescriptors || []) if (d && d.key) desc[d.key.toLowerCase()] = d.index;
  const ti = desc.timestamp != null ? desc.timestamp : 0, hi = desc.heartrate != null ? desc.heartrate : 1;
  const base = num(rhr) || num(hrDto.restingHeartRate) || num(hrDto.minHeartRate);
  if (base == null) return null;

  const buckets = new Map();
  for (const row of hrDto.heartRateValues) {
    if (!Array.isArray(row)) continue;
    const t = gmtMs(row[ti]), hr = num(row[hi]);
    if (t == null || hr == null || hr <= 0) continue;
    const k = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    const b = buckets.get(k) || { s: 0, n: 0 };
    b.s += hr; b.n++; buckets.set(k, b);
  }
  if (!buckets.size) return null;

  const acts = (activitiesRaw || []).map((a) => {
    const s = gmtMs(a.startTimeGMT), dur = num(a.duration) || num(a.elapsedDuration) || 0;
    return s != null ? [s, s + dur * 1000] : null;
  }).filter(Boolean);
  const sleep = sleepDto ? [gmtMs(sleepDto.sleepStartTimestampGMT), gmtMs(sleepDto.sleepEndTimestampGMT)] : null;
  const inRange = (t, r) => r && r[0] != null && r[1] != null && t + BUCKET_MS > r[0] && t < r[1];

  const points = [...buckets.keys()].sort((a, b) => a - b).map((t) => {
    const hr = buckets.get(t).s / buckets.get(t).n;
    const flag = acts.some((r) => inRange(t, r)) ? "a" : inRange(t, sleep) ? "s" : "";
    return [t, Math.round(clamp((hr - base) / STRESS_BPM_PER_POINT, 0, 3) * 100) / 100, flag, Math.round(hr)];
  });

  // Glätten über 15 Minuten (Nachbarblöcke), damit einzelne Puls-Ausreißer nicht als Stress zählen
  const raw = points.map((p) => p[1]);
  points.forEach((p, i) => {
    const nb = [i - 1, i, i + 1].filter((j) => j >= 0 && j < points.length && Math.abs(points[j][0] - p[0]) <= BUCKET_MS);
    p[1] = Math.round((nb.reduce((sum, j) => sum + raw[j], 0) / nb.length) * 100) / 100;
  });

  // Auswertung nur für Wachzeit ohne Aktivität
  const awake = points.filter((p) => p[2] === "");
  const minutes = { low: 0, medium: 0, high: 0 };
  let highEpisodes = 0, prevHigh = false;
  for (const p of awake) {
    const lvl = p[1] >= 2 ? "high" : p[1] >= 1 ? "medium" : "low";
    minutes[lvl] += 5;
    if (lvl === "high" && !prevHigh) highEpisodes++;
    prevHigh = lvl === "high";
  }
  const last = awake.slice(-3);
  const current = last.length ? last.reduce((s, p) => s + p[1], 0) / last.length : null;
  return {
    points,
    sleep: sleep && sleep[0] != null && sleep[1] != null ? sleep : null,
    activities: acts,
    current,
    level: current == null ? null : current >= 2 ? "high" : current >= 1 ? "medium" : "low",
    updatedAt: points[points.length - 1][0],
    minutes,
    highEpisodes,
    baseRhr: base,
    bpmPerPoint: STRESS_BPM_PER_POINT,
  };
}

// HRV-Einzelwerte der Nacht (Garmin: ca. alle 5 Minuten im Schlaf)
export function buildHrvNight(h) {
  const pts = ((h && h.hrvReadings) || [])
    .map((r) => [gmtMs(r.readingTimeGMT), num(r.hrvValue)])
    .filter((p) => p[0] != null && p[1] != null && p[1] > 0)
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;
  const sum = (h && h.hrvSummary) || {};
  const b = sum.baseline || {};
  return {
    points: pts,
    avg: num(sum.lastNightAvg),
    high5: num(sum.lastNight5MinHigh),
    weeklyAvg: num(sum.weeklyAvg),
    balanced: num(b.balancedLow) != null && num(b.balancedUpper) != null ? [b.balancedLow, b.balancedUpper] : null,
    status: sum.status || null,
  };
}
