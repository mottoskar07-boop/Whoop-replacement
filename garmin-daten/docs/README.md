# Garmin Connect Personal API – Referenz

Quelle: developer.garmin.com/gc-developer-program/personal/ (Stand 2026-10-29)

- `personal-api-openapi.json` – Garmins Swagger/OpenAPI-Spezifikation, unverändert extrahiert.
- Server: `https://personal.connectapi.garmin.com`
- Token holen: `POST /personalapitoken-service/personal-api/personal-api-key/token`
  mit Header `Authorization: ApiKey <key>`
- Token gilt 24 h (oder bis der Schlüssel abläuft); keine Refresh-Tokens, einfach neu holen.
- Schlüssel-Laufzeit: 30, 90, 180 Tage oder 1 Jahr; wird nur einmal angezeigt.
- Rate-Limits: in der Doku nicht angegeben.
