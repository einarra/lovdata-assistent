# Compliance Notes – OpenAI & Lovdata Terms

## OpenAI Usage

- **Data sent**: user question, evidence snippets (Lovdata extracts/public fallback). Avoid sending secrets/PII in prompts.  
- **Storage**: OpenAI may retain data for policy enforcement. Configure account settings to disable data retention for training if required.  
- **User disclosure**: inform end-users that questions are processed by OpenAI. Provide privacy policy link.  
- **Key management**: `OPENAI_API_KEY` must be stored in secure secret manager (not `.env` in repo). CI fails fast if missing.

## Lovdata Requirements

- Public archives only (`/v1/public/*`).  
- `/documents/xml` streams content directly without modification beyond styling; ensure downstream caching respects headers.  
- Do not expose private Lovdata data or circumvent licensing.  
- Attribute Lovdata as source in UI (already via evidence list).

## Data Retention

- Archive cache (`backend/data/archives/`) stores public documents for performance.  
  - Periodically purge unused archives.  
  - Do not store user-specific data alongside archives.  
- Logs: avoid storing full responses/questions in prod logs; consider redaction strategy.  
- No persistent storage of user conversations beyond in-memory state unless explicitly added with consent.

## Operational Steps

- Review third-party agreements before production deployment.  
- Include compliance checklist in release process.  
- Monitor `/metrics` and `/ready` endpoints to detect anomalies.

