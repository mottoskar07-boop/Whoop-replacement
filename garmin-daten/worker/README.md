# whoop-replacement Worker

Cloudflare Worker, der die Garmin Connect Personal API nur lesend abfragt.
Wird von Cloudflare Workers Builds bei jedem Push auf diesen Branch automatisch
veröffentlicht (Root directory: `garmin-daten/worker`).

Secrets (nur im Cloudflare-Dashboard unter Settings → Variables and Secrets,
Typ "Secret"; nie ins Repo):

- `GARMIN_API_KEY` – persönlicher API-Schlüssel aus Garmin Connect
- `APP_CODE` – eigener Zugangscode für diesen Worker

Verbindungstest: `https://<worker-adresse>/test?code=<APP_CODE>`
