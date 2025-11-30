# GDPR Data Collection Review

**Date:** 2025-01-XX  
**Status:** Review Complete

## Executive Summary

This review examines what user data is being collected, stored, and logged in the Lovdata Assistant application to ensure GDPR compliance and accurate disclosure in the consent form.

## Findings

### ✅ What We Are NOT Collecting (Persistently)

1. **Chat History / Conversation Storage**
   - ❌ No database table for storing user queries or chat history
   - ❌ No persistent storage of conversations in Supabase
   - ❌ Frontend messages are only stored in React state (in-memory, cleared on page refresh)
   - ❌ No localStorage or sessionStorage for chat history

2. **Search History**
   - ❌ No database table for storing search queries
   - ❌ No persistent search history tracking

### ⚠️ What We ARE Collecting

1. **Application Logs**
   - ✅ User questions ARE being logged via `logger.info({ question, ... })` in `backend/src/services/assistant.ts:59`
   - ✅ Logs may be written to files if `LOG_FILE` environment variable is set
   - ✅ Logs include: question text, page, pageSize, userId (if available)
   - ⚠️ **Risk**: Full user questions are logged, which may contain PII or sensitive information

2. **Authentication Data**
   - ✅ Email address (via Supabase Auth)
   - ✅ User ID (via Supabase Auth)
   - ✅ Session tokens (temporary, in Supabase)

3. **GDPR Consent Records**
   - ✅ Consent status stored in `gdpr_consents` table
   - ✅ IP address and user agent captured when consent is given

4. **Subscription Data** (if applicable)
   - ✅ Stripe customer ID
   - ✅ Subscription status
   - ✅ Billing information (via Stripe)

### 🔍 Code Locations

**Logging User Questions:**
- `backend/src/services/assistant.ts:59` - Logs question when assistant run starts
- `backend/src/http/app.ts:269` - Logs question in request handler
- `backend/src/logger.ts` - Logger configuration (can write to files)

**Frontend State (Non-Persistent):**
- `frontend/src/App.tsx:14` - Messages stored in React state only
- Messages are cleared when user refreshes page or logs out

## GDPR Compliance Issues

### 1. **Inaccurate Consent Form Disclosure**

The current GDPR consent form states:
> "Bruksdata (spørsmål du stiller, søkehistorikk)"

**Problem**: This implies we're storing search history in a database, which we're not. However, we ARE logging questions in application logs.

**Recommendation**: Update the consent form to accurately reflect:
- Questions are logged for debugging/operational purposes (not stored in database)
- Logs may contain full question text
- Log retention policy should be documented

### 2. **Log Retention Policy Missing**

**Problem**: No documented policy for:
- How long logs are retained
- Whether logs containing user questions are redacted
- Log access controls

**Recommendation**: 
- Document log retention policy (e.g., 30 days, 90 days)
- Consider redacting sensitive information from logs in production
- Implement log rotation/cleanup

### 3. **OpenAI Data Sharing**

**Current Disclosure**: The form mentions data sharing but doesn't specifically mention OpenAI.

**Recommendation**: Explicitly state that:
- User questions are sent to OpenAI for processing
- OpenAI may retain data according to their privacy policy
- Users should review OpenAI's data retention settings

## Recommendations

### Immediate Actions

1. **Update GDPR Consent Form** (`frontend/src/pages/gdprConsent.tsx`)
   - Change "Bruksdata (spørsmål du stiller, søkehistorikk)" to accurately reflect logging
   - Add explicit mention of OpenAI data sharing
   - Clarify that chat history is NOT stored in database

2. **Document Log Retention Policy**
   - Add to `docs/security/compliance.md`
   - Specify retention period (e.g., 30 days)
   - Document log cleanup procedures

3. **Consider Log Redaction** (Optional but Recommended)
   - Redact or truncate user questions in production logs
   - Keep full logs only in development
   - Or hash questions instead of logging full text

### Future Considerations

1. **If Chat History is Needed**
   - Create `user_conversations` table in Supabase
   - Update GDPR consent form to include this
   - Implement proper RLS policies
   - Add data retention/cleanup policies

2. **Log Management**
   - Implement structured logging with PII flags
   - Use log aggregation service (e.g., Datadog, LogRocket)
   - Implement automatic log rotation

## Current Data Flow

```
User Question
    ↓
Frontend (React State - in-memory only)
    ↓
Backend API (/assistant/run)
    ↓
Logger (logs question to stdout/file) ← ⚠️ PERSISTENT IF LOG_FILE SET
    ↓
OpenAI API (processes question) ← ⚠️ OPENAI MAY RETAIN
    ↓
Response returned to user
    ↓
Frontend displays response (in-memory only)
```

## Compliance Status

| Data Type | Collected | Stored in DB | Logged | GDPR Disclosure | Status |
|-----------|-----------|-------------|--------|-----------------|--------|
| Email | ✅ | ✅ (Supabase Auth) | ❌ | ✅ | ✅ Compliant |
| User Questions | ✅ | ❌ | ✅ | ⚠️ Inaccurate | ⚠️ Needs Fix |
| Chat History | ❌ | ❌ | ❌ | ⚠️ Implied | ⚠️ Needs Clarification |
| Search History | ❌ | ❌ | ❌ | ⚠️ Implied | ⚠️ Needs Clarification |
| IP Address | ✅ | ✅ (on consent) | ✅ | ✅ | ✅ Compliant |
| User Agent | ✅ | ✅ (on consent) | ✅ | ✅ | ✅ Compliant |

## Next Steps

1. ✅ Review complete
2. ⏳ Update GDPR consent form text
3. ⏳ Document log retention policy
4. ⏳ Consider log redaction strategy
5. ⏳ Add OpenAI data sharing disclosure

