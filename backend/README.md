# Lovdata Assistant Backend

This backend is a TypeScript implementation based on the [agent-skills-ts-template](https://github.com/einarra/agent-skills-ts-template/tree/main). It exposes a lightweight skill orchestrator over HTTP so the Lovdata Assistant frontend can trigger structured capabilities.

## Features

- Express-based API med `/health`, `/ready`, `/metrics`, `/session` og `POST /assistant/run`
- Supabase-beskyttet identitet (Bearer-token) for alle beskyttede endepunkter
- Lovdata API-skill for åpne datasett (`https://api.lovdata.no`)
- Serper fallback-søk for `lovdata.no`
- Sentralisert miljøvalidering og strukturert logging (Pino)
- Vitest tester av kjernefunksjonalitet

## Getting Started

```bash
cd /Users/einarrasmussen/projects/SpektralLab/Lovdata/backend
cp env.example .env
npm install
npm run dev
```

The server listens on `PORT` (defaults to `4000`).  The `npm run start` script also boots the TypeScript sources via `tsx` and is suitable for production when combined with a process supervisor.

## Archive Sync

The backend uses Supabase for archive storage. To sync archives from lovdata-api to Supabase:

### Automatic Sync on Startup

Enable automatic sync when the backend starts:

```bash
# In your .env file
SYNC_ARCHIVES_ON_STARTUP=true
```

When enabled, the backend will automatically check for new archives on startup and process any that haven't been imported yet.

### Manual Sync

Run the sync manually from the terminal:

```bash
# Sync all new archives
npm run sync-archives

# Skip storage upload (only update Postgres)
npm run sync-archives -- --skip-storage

# Show help
npm run sync-archives -- --help
```

The sync script will:
- Check lovdata-api for available archives
- Compare with Supabase to find new archives
- Process new archives (extract documents, save to Postgres)
- Skip archives that are already processed
- Print a summary report

### Migration Scripts

For initial migration from SQLite to Supabase:

```bash
# Export data from SQLite
npm run export-lovdata

# Import to Supabase Postgres
npm run import-lovdata

# Upload archive files to Supabase Storage
npm run upload-lovdata-storage

# Verify migration completeness
npm run verify-supabase-migration
```

## Environment Variables

Use `env.example` as the base for your `.env`. Key settings:

- `PUBLIC_API_BASE_URL` – external URL used to build document links (must not be localhost in production)
- `LOVDATA_BASE_URL` – upstream Lovdata API (defaults to `https://api.lovdata.no`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` – Supabase Auth & database (required)
- `SYNC_ARCHIVES_ON_STARTUP` – enable automatic archive sync on startup (default: `false`)
- `OPENAI_API_KEY` / `OPENAI_MODEL` – required for LLM answers
- `SERPER_API_KEY` – optional fallback search provider
- `LOG_LEVEL`, `PORT`, `LOVDATA_TIMEOUT_MS` – server tuning knobs

In production the server fails fast unless the essentials (`OPENAI_API_KEY`, Supabase keys, non-localhost public URL, HTTPS Lovdata endpoint) are configured.

### Seeding existing users

Hvis du har en liste over eksisterende brukere som skal kunne logge inn med passord (uten magisk lenke):

```bash
# Konfigurer .env med SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ valgfri DEFAULT_USER_PASSWORD)
npm run create-supabase-users -- bruker1@example.com:hemmeligPass bruker2@example.com
```

- Formatet er `email[:password]`. Hvis passordet utelates brukes `.env`-variabelen `DEFAULT_USER_PASSWORD`.
- Bruk Supabase-dashboardet til å sende «tilbakestill passord»-eposter senere, eller la brukeren velge passord ved første innlogging.

## API

### `GET /health`
Returns uptime, readiness flag, and archive index status.

### `GET /ready`
Returns `200` when the archive index is ready. Responds `503` otherwise.

### `GET /metrics`
Prometheus-formatted metrics (trace durations, error counts, default process metrics).

### `POST /skills/run`
Executes the skill orchestrator. Example payloads:

```json
{
  "input": {
    "action": "listPublicData"
  }
}
```

```json
{
  "input": {
    "action": "fetchJson",
    "path": "/v1/publicData/list"
  }
}
```

```json
{
  "input": "Search Lovdata for arbeidsmiljøloven updates"
}
```

The orchestrator automatically routes to the best matching skill and returns its output.

## Testing

Run the TypeScript compiler and unit tests:

```bash
npm run build
npm test
```

The current test suite covers input normalisation and can be expanded for additional behaviours.

## Notes

- **Archive Storage**: The backend uses Supabase (Postgres + Storage) for archive data. The old SQLite-based storage has been removed.
- **Archive Sync**: Use `npm run sync-archives` to manually sync new archives, or set `SYNC_ARCHIVES_ON_STARTUP=true` for automatic sync on startup.
- **Storage Upload**: Archive files are saved to Supabase Postgres automatically. To upload archive bundles to Supabase Storage, run `npm run upload-lovdata-storage` separately.
- If `SERPER_API_KEY` is absent, the Serper skill will return a configured=false payload.
- The Lovdata skill only supports read-only access; extend `src/services/lovdataClient.ts` for more endpoints if Lovdata expands the public API.
- After building, `dist/` contains the compiled runtime. Copy the `src/skills/*/skill.json` manifests alongside the compiled output when packaging for deployment.
- For CI/CD the repository ships with `.github/workflows/ci.yml` (lint/test/audit).
