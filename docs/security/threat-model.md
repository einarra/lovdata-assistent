# Threat Model – Lovdata Assistant

## Data Flows

- **Inbound**: `/assistant/run` receives user questions (PII possible) and calls:
  - Skill orchestrator (`lovdata-api`, `lovdata-serper`)
  - Optional OpenAI agent (`OPENAI_API_KEY`)
  - Lovdata public archives (streamed, cached locally)
- **Outbound**:
  - Lovdata API (`LOVDATA_BASE_URL`)
  - Serper fallback (`SERPER_API_KEY`)
  - OpenAI API (question, evidence snippets)
- **Local Storage**:
  - `backend/data/archives/` extracted public documents
  - SQLite FTS index (`backend/data/lovdata.db`)
  - Structured logs via Pino (stdout)

## Asset Inventory

| Asset | Type | Sensitivity | Notes |
|-------|------|-------------|-------|
| OpenAI API key | Secret | High | Exposed if backend compromised |
| Serper API key | Secret | Medium | Optional fallback |
| Lovdata content | Public | Low | Must respect usage terms |
| User questions | Potential PII | Medium | Avoid persistent storage |
| Response logs | Application | Medium | Consider redaction in prod |

## Threats

1. **Abuse of public endpoints** (`/assistant/run`, `/documents/xml`)  
   - Risk: scraping Lovdata content, exhausting OpenAI quota  
   - Mitigation: add authentication/rate limits before production

2. **API key leakage**  
   - Risk: logs, config, or repository exposures  
   - Mitigation: env validation, secret management, never log keys, restrict read access

3. **Prompt/data leakage via OpenAI**  
   - Risk: sending sensitive user data to OpenAI  
   - Mitigation: document usage, inform users, optional redaction layer

4. **Lovdata compliance violations**  
   - Risk: serving private content or exposing beyond public license  
   - Mitigation: only ingest public archives, `/documents/xml` respects licensing headers

5. **Denial of Service**  
   - Risk: expensive search queries, reindex triggers  
   - Mitigation: streaming ingestion, FTS search, consider request throttling, background workers

6. **Supply chain vulnerabilities**  
   - Risk: dependency CVEs  
   - Mitigation: CI `npm audit`, future Snyk integration, renovate passes

## Recommendations

- Enforce auth/rate limiting before exposing externally.
- Add input validation/sanitisation on `/documents/xml` query params (already using Zod).
- Configure centralized logging + monitoring (trace ID shipped, metrics ready).
- Periodic review of archive cache + data retention.

