// Verbindungstest für die Garmin Connect Personal API.
// Secrets (nur im Cloudflare-Dashboard gesetzt, nie im Code):
//   GARMIN_API_KEY  – persönlicher API-Schlüssel aus Garmin Connect
//   APP_CODE        – eigener Zugangscode, schützt diesen Worker
// Nur lesende Abfragen (GET). Schlüssel und Token werden nie ausgegeben.

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

function isoDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Holt ein Zugangs-Token. Gibt das Token zurück plus eine Beschreibung der
// Antwort-Struktur (nur Feldnamen und Typen, keine Werte).
async function getToken(env) {
  const res = await fetch(BASE + TOKEN_PATH, {
    method: "POST",
    headers: { Authorization: "ApiKey " + env.GARMIN_API_KEY },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const shape = body && typeof body === "object"
    ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v]))
    : { contentType: res.headers.get("content-type"), length: text.length };
  let token = null;
  if (res.ok) {
    if (body && typeof body === "object") {
      const key = Object.keys(body).find((k) => /token/i.test(k) && typeof body[k] === "string");
      token = key ? body[key] : null;
      shape._tokenField = key || null;
    } else if (text && !text.includes(" ")) {
      token = text.trim();
    }
  }
  return { status: res.status, retryAfter: res.headers.get("retry-after"), shape, token };
}

async function get(path, token) {
  const res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
}

function describe(r) {
  const out = { status: r.status };
  if (r.retryAfter) out.retryAfter = r.retryAfter;
  const b = r.body;
  if (Array.isArray(b)) {
    out.count = b.length;
    out.fields = b.length ? Object.keys(b[0]) : [];
  } else if (b && typeof b === "object") {
    out.fields = Object.keys(b);
  }
  return out;
}

async function connectionTest(env) {
  if (!env.GARMIN_API_KEY) return { error: "Secret GARMIN_API_KEY fehlt" };
  const t = await getToken(env);
  const result = { token: { status: t.status, retryAfter: t.retryAfter, shape: t.shape } };
  if (!t.token) return result;

  const acts = (from, to) =>
    `/activitylist-service/activities/search/activities?startDate=${isoDate(from)}&endDate=${isoDate(to)}&limit=99`;

  // Nacheinander statt parallel, um Garmin nicht zu fluten. Bei 429 sofort aufhören.
  const checks = [
    ["aktivitaeten_letzte_7_tage", acts(7, 0)],
    ["schlaf_letzte_nacht", `/sleep-service/sleep/dailySleep?date=${isoDate(0)}`],
    ["hrv_letzte_7_tage", `/hrv-service/hrv/daily/${isoDate(7)}/${isoDate(0)}`],
    ["tageszusammenfassung_heute", `/usersummary-service/usersummary/daily?calendarDate=${isoDate(0)}`],
    ["aktivitaeten_vor_30_tagen", acts(37, 30)],
    ["aktivitaeten_vor_180_tagen", acts(187, 180)],
    ["hrv_vor_180_tagen", `/hrv-service/hrv/daily/${isoDate(187)}/${isoDate(180)}`],
  ];
  for (const [name, path] of checks) {
    const r = await get(path, t.token);
    result[name] = describe(r);
    if (name === "hrv_letzte_7_tage" && r.body && Array.isArray(r.body.hrvSummaries)) {
      result[name].tage = r.body.hrvSummaries.length;
    }
    if (r.status === 429) { result.abgebrochen = "429 – zu viele Anfragen, bitte später erneut"; break; }
  }
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("whoop-replacement läuft. Test: /test?code=DEIN_CODE", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/test") {
      if (!env.APP_CODE || url.searchParams.get("code") !== env.APP_CODE) {
        return json({ error: "Zugangscode fehlt oder falsch" }, 401);
      }
      return json(await connectionTest(env));
    }
    return json({ error: "nicht gefunden" }, 404);
  },
};
