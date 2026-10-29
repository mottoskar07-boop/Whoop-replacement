// whoop-replacement: App im Whoop-Stil auf Basis der Garmin Connect Personal API.
// Secrets (nur im Cloudflare-Dashboard, nie im Code):
//   GARMIN_API_KEY  – persönlicher API-Schlüssel aus Garmin Connect
//   APP_CODE        – eigener Zugangscode, schützt alle /api-Adressen
// KV-Speicher DATA: Garmin-Token-Cache, Journal, Verhaltensliste.
// Garmin wird nur lesend abgefragt. Schlüssel und Token werden nie ausgegeben.

import APP_HTML from "./app.html";
import { ICON_SVG } from "./icon.js";
import { garminGet, garminGetRaw, GarminError } from "./garmin.js";
import { addDays, buildDay, buildStress, buildHrvNight } from "./scores.js";

const WINDOW_DAYS = 30;
const DAY_CACHE_MS = 60 * 1000;
const dayCache = new Map(); // pro Worker-Instanz, schont Garmin bei schnellem Neuladen

const DEFAULT_BEHAVIORS = [
  { id: "alcohol", label: "Alkohol getrunken" },
  { id: "caffeine_late", label: "Koffein nach 14 Uhr" },
  { id: "late_meal", label: "Spät gegessen (< 2 h vor dem Schlafen)" },
  { id: "screen_bed", label: "Handy/Bildschirm im Bett" },
  { id: "sauna", label: "Sauna" },
  { id: "cold", label: "Kaltdusche / Eisbad" },
  { id: "magnesium", label: "Magnesium genommen" },
  { id: "hydrated", label: "Ausreichend getrunken" },
  { id: "stress", label: "Viel Stress" },
  { id: "sick", label: "Krank / Symptome" },
  { id: "reading", label: "Vor dem Schlafen gelesen" },
  { id: "meditation", label: "Meditation / Atemübung" },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sameCode(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function loadDay(env, D, fresh) {
  const hit = dayCache.get(D);
  if (hit && Date.now() - hit.t < (fresh ? 15000 : DAY_CACHE_MS)) return hit.body;
  const from = addDays(D, -WINDOW_DAYS);
  const [activities, hrv, sleep, summaries] = await Promise.all([
    garminGet(env, `/activitylist-service/activities/search/activities?startDate=${from}&endDate=${D}&limit=99`),
    garminGet(env, `/hrv-service/hrv/daily/${from}/${D}`),
    garminGet(env, `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${from}&endDate=${D}`),
    garminGet(env, `/usersummary-service/v2/dailysummaries?startDate=${from}&endDate=${D}`),
  ]);
  const body = buildDay(D, { activities, hrv, sleep, summaries }, WINDOW_DAYS);
  // HRV-Verlauf der Nacht (Garmin misst HRV nur im Schlaf)
  try {
    const h = await garminGet(env, `/hrv-service/hrv/${D}`);
    body.hrvNight = buildHrvNight(h);
  } catch (e) {
    body.hrvNight = null;
  }
  // Stress-Monitor: eigener Abruf, ein Fehler hier soll die übrige App nicht blockieren
  try {
    const hr = await garminGet(env, `/wellness-service/wellness/dailyHeartRate?date=${D}`);
    const dayActs = (activities || []).filter((a) => String(a.startTimeLocal || "").startsWith(D) || (typeof a.startTimeLocal === "number" && new Date(a.startTimeLocal).toISOString().startsWith(D)));
    body.stress = buildStress(hr, (sleep || []).find((x) => x && x.calendarDate === D), dayActs, body.recovery ? body.recovery.rhr : (body.stats.rhr.value));
  } catch (e) {
    body.stress = null;
    body.warnings.push("Stress-Monitor: Pulsverlauf nicht abrufbar (" + (e.status || e.message) + ").");
  }
  body.updatedAt = new Date().toISOString();
  dayCache.set(D, { t: Date.now(), body });
  return body;
}

async function readJournal(env) {
  const [entries, behaviors] = await Promise.all([
    env.DATA.get("journal", "json"),
    env.DATA.get("behaviors", "json"),
  ]);
  return { entries: entries || {}, behaviors: behaviors || DEFAULT_BEHAVIORS };
}

async function handleApi(request, env, url) {
  const p = url.pathname;

  if (p === "/api/day" && request.method === "GET") {
    const D = url.searchParams.get("date");
    if (!isDate(D)) return json({ error: "date fehlt (YYYY-MM-DD)" }, 400);
    return json(await loadDay(env, D, url.searchParams.has("fresh")));
  }

  // Original-Aktivitätsdatei (ZIP mit FIT) – wird im Browser ausgewertet (Puls- und HRV-Verlauf)
  const fm = p.match(/^\/api\/activity\/(\d{1,20})\/file$/);
  if (fm && request.method === "GET") {
    const f = await garminGetRaw(env, `/download-service/files/activity/${fm[1]}`);
    return new Response(f.body, { headers: { "content-type": f.type, "cache-control": "private, max-age=86400" } });
  }

  if (!env.DATA) return json({ error: "KV-Speicher DATA ist nicht verbunden" }, 503);

  if (p === "/api/zones" && request.method === "GET") {
    let zones = await env.DATA.get("hr-zones", "json");
    if (!zones) {
      zones = await garminGet(env, "/biometric-service/heartRateZones/v2?generateDefaults=true");
      await env.DATA.put("hr-zones", JSON.stringify(zones), { expirationTtl: 12 * 3600 });
    }
    return json(zones);
  }

  if (p === "/api/journal" && request.method === "GET") return json(await readJournal(env));

  const m = p.match(/^\/api\/journal\/(\d{4}-\d{2}-\d{2})$/);
  if (m && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.answers !== "object") return json({ error: "answers fehlt" }, 400);
    const { entries } = await readJournal(env);
    const answers = {};
    for (const [k, v] of Object.entries(body.answers)) if (typeof v === "boolean") answers[String(k).slice(0, 40)] = v;
    entries[m[1]] = { answers, note: String(body.note || "").slice(0, 500), savedAt: new Date().toISOString() };
    await env.DATA.put("journal", JSON.stringify(entries));
    return json({ ok: true });
  }

  if (p === "/api/behaviors" && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.behaviors)) return json({ error: "behaviors fehlt" }, 400);
    const list = body.behaviors
      .filter((b) => b && typeof b.id === "string" && typeof b.label === "string")
      .slice(0, 40)
      .map((b) => ({ id: b.id.slice(0, 40), label: b.label.slice(0, 60) }));
    await env.DATA.put("behaviors", JSON.stringify(list));
    return json({ ok: true, behaviors: list });
  }

  return json({ error: "nicht gefunden" }, 404);
}

const MANIFEST = {
  name: "Recovery",
  short_name: "Recovery",
  start_url: "/",
  display: "standalone",
  background_color: "#101518",
  theme_color: "#101518",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json" } });
    }
    if (url.pathname === "/icon.svg") {
      return new Response(ICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!env.APP_CODE || !sameCode(request.headers.get("x-app-code"), env.APP_CODE)) {
        return json({ error: "Zugangscode falsch" }, 401);
      }
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        if (e instanceof GarminError) {
          return json({ error: e.message, garminStatus: e.status, retryAfter: e.retryAfter || null }, 502);
        }
        return json({ error: "Interner Fehler: " + (e && e.message) }, 500);
      }
    }

    return json({ error: "nicht gefunden" }, 404);
  },
};
