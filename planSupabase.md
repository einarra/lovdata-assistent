## Migration Plan Overview

- **Discovery & Assessment**
  - Identify every data source and consumer across the project (files under `Lovdata`, other archives, existing SQLite DBs).
  - Document current schemas, relationships, data volumes, retention needs, and access patterns.
  - Flag sensitive fields; confirm compliance requirements before cloud transfer.
  - **Current snapshot (2025-11-12):**
    - Archive bundles stored under `backend/data/archives`: `gjeldende-lover.tar.bz2`, `gjeldende-sentrale-forskrifter.tar.bz2`, `lovtidend-avd1-2001-2024.tar.bz2`, `lovtidend-avd1-2025.tar.bz2`. Combined ingest equals 4 archive records and 41,934 document rows in `backend/data/lovdata.db`.
    - `lovdata.db` tables: `archives` (filename, processed_at, document_count) and `documents` (id, archive_filename, member, title, date, content, relative_path) with FTS5 (`documents_fts`) + triggers for content sync.
    - Legacy `auth.db` still present (tables: `users`, `sessions`, `subscriptions`, `portal_sessions`, `login_tokens`) holding small residual data (e.g., 1 user, 16 sessions). Runtime auth now uses Supabase; decide whether to migrate or retire this database.
    - Application consumers of archives: `archiveIngestor` (bootstrap ingestion via Lovdata API), `archiveStore` (SQLite access + disk mirror), `lovdataSearch` (search API/skills), `assistant` service (evidence hydration), `/documents/xml` HTTP route (serves content with Supabase auth guard).

- **Supabase Environment Setup**
  - Project: `Lovdata-assistent` (already provisioned). Ensure environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`) are loaded from `.env` in both backend and frontend builds—never commit secrets.
  - Authenticate Supabase CLI locally (`supabase login`) and link the project (`supabase link --project-ref <lovdata-ref>`). Store the generated `.supabase` config outside of version control.
  - Provision Postgres backups and PITR in the Supabase dashboard; align retention with archive compliance needs.
  - Create storage buckets:
    - `lovdata-archives` (private) for compressed upstream bundles.
    - `lovdata-documents` (private) for normalized XML/HTML assets (if they must remain accessible outside DB).
    - Configure lifecycle policies and object versioning per data retention policy.
  - Define storage policies so only the service role can write; optionally allow signed URL reads for archived doc previews.
  - Enable observability (query insights, logs) and set up initial alerting (e.g., failed functions, storage quota).

- **Schema & Storage Design**
  - Translate `lovdata.db` to Postgres tables:
    - `lovdata_archives` mirroring `archives` (columns: filename PK, processed_at timestamptz, document_count int).
    - `lovdata_documents` mirroring `documents` (bigint id PK, archive_filename FK → `lovdata_archives`, member text, title text, date text, content text, relative_path text).
    - Implement full-text search via `to_tsvector` generated column + `GIN` index (e.g., `tsv_content`) or Supabase `pg_search` extension.
    - Add unique index on `(archive_filename, member)` to enforce deduping.
  - Map storage references: store raw bundles in `lovdata-archives/<filename>` and normalized files in `lovdata-documents/<archive_filename>/<member>`. Keep relative paths aligned with Postgres `relative_path`.
  - Seed `public.user_subscriptions` / `public.stripe_webhook_events` and new `lovdata_*` tables by running `backend/supabase/schema.sql`; ensure `set_current_timestamp()` helper exists (Supabase default).
  - Document data classification (public law text vs. private auth data) to drive RLS policies and bucket access decisions.
  - ✅ Buckets (`lovdata-archives`, `lovdata-documents`) created in Supabase project; tables deployed via SQL migration.

- **Migration Tooling**
  - Implement migration scripts under `backend/scripts/`:
    - `exportLovdata.ts`: reads `data/lovdata.db`, streams archives/documents to JSONL (`lovdata-archives.jsonl`, `lovdata-documents.jsonl`) plus summary manifest; configurable batch size/output dir. ✅ `npm run export-lovdata`.
    - `importLovdata.ts`: takes JSONL output and upserts into Supabase (`lovdata_archives`, `lovdata_documents`) via service-role client, with batching, dry-run, and on-conflict safety. ✅ `npm run import-lovdata`.
    - `uploadLovdataStorage.ts`: uploads local tar bundles / normalized XML trees into Supabase Storage buckets (`lovdata-archives`, `lovdata-documents`), configurable dirs/buckets, dry-run support. ✅ `npm run upload-lovdata-storage`.
  - Reuse existing Supabase env values but guard execution (confirm prompts / dry-run). Document required env variables in `README.md`.
  - Ensure scripts are idempotent: UPSERT on `(archive_filename, member)`; after import, verify counts per archive match `document_count`.
  - For large payloads, consider gzip compression and chunk requests to stay under Supabase limits (~50 MB/request).

- **Data Integrity & Verification**
  - Run row counts, checksums, and spot checks comparing SQLite vs Supabase data.
  - Validate foreign keys, unique constraints, timestamps, and archive references.
  - Confirm Supabase storage metadata matches Postgres records.

- **Application Updates**
  - Abstract data layer to use Supabase client; refactor queries to SQL templates/rest endpoints.
  - Replace local file access with Supabase storage APIs; update access controls.
  - Introduce configuration toggles to switch between SQLite/local and Supabase during rollout.

- **Testing & Rollout**
  - Build staging environment mirroring production structure; run automated/regression tests.
  - Conduct performance and load tests on Supabase.
  - Plan cutover window, freeze local writes, run final sync, switch configuration, monitor metrics/logs.

- **Post-Migration Tasks**
  - Set up monitoring (Supabase metrics, error alerts), backup schedules, and disaster recovery procedures.
  - Document new architecture, credentials, and runbooks.
  - Decommission old SQLite/db files once stability confirmed and compliance approvals obtained.

