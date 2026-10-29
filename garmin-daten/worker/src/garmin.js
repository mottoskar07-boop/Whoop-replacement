// Zugriff auf die Garmin Connect Personal API (nur GET-Abfragen für Daten).
// Adressen und Authentifizierung laut Garmins Doku in garmin-daten/docs/.

export const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const TOKEN_KV_KEY = "garmin-token";
const TOKEN_TTL_SECONDS = 23 * 3600; // Garmin: Token gilt 24 h

export class GarminError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Token-Antwort ist laut Verbindungstest reiner Text; JSON wird trotzdem unterstützt.
function parseToken(text) {
  const t = text.trim();
  try {
    const body = JSON.parse(t);
    if (typeof body === "string") return body;
    if (body && typeof body === "object") {
      const key = Object.keys(body).find((k) => /token/i.test(k) && typeof body[k] === "string");
      if (key) return body[key];
    }
  } catch {}
  return t && !/\s/.test(t) ? t : null;
}

async function fetchToken(env) {
  if (!env.GARMIN_API_KEY) throw new GarminError(500, "Secret GARMIN_API_KEY fehlt");
  const res = await fetch(BASE + TOKEN_PATH, {
    method: "POST",
    headers: { Authorization: "ApiKey " + env.GARMIN_API_KEY },
  });
  if (!res.ok) {
    throw new GarminError(res.status, "Token-Abruf fehlgeschlagen", res.headers.get("retry-after"));
  }
  const token = parseToken(await res.text());
  if (!token) throw new GarminError(502, "Token-Antwort unbekanntes Format");
  if (env.DATA) await env.DATA.put(TOKEN_KV_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS });
  return token;
}

async function getToken(env, forceNew = false) {
  if (!forceNew && env.DATA) {
    const cached = await env.DATA.get(TOKEN_KV_KEY);
    if (cached) return cached;
  }
  return fetchToken(env);
}

// GET mit Token. Bei 401 einmal neuen Token holen; bei 429 sofort Fehler, kein Wiederholen.
export async function garminGet(env, path) {
  let token = await getToken(env);
  let res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) {
    token = await getToken(env, true);
    res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
  }
  if (!res.ok) {
    throw new GarminError(res.status, "Garmin antwortet mit " + res.status + " für " + path.split("?")[0],
      res.headers.get("retry-after"));
  }
  return res.json();
}
