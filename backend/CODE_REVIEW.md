# Code Review: Supabase Migration - Production Readiness

**Date:** 2025-01-12  
**Reviewer:** AI Code Review  
**Status:** ⚠️ **Needs Attention Before Production**

## Executive Summary

The migration from SQLite to Supabase is well-structured and mostly production-ready. However, there are several critical issues that must be addressed before deploying to production:

1. **Critical:** Server continues running even if Supabase initialization fails
2. **Critical:** Missing transaction safety in `replaceDocumentsAsync`
3. **High:** Path traversal vulnerability in storage paths
4. **High:** Missing error handling for `.single()` queries
5. **Medium:** Performance concerns with search queries
6. **Medium:** Missing input validation

---

## Critical Issues

### 1. Server Starts Even If Supabase Fails ⚠️ CRITICAL

**Location:** `src/index.ts:17-19`

```typescript
} catch (error) {
  logger.error({ err: error }, 'Failed to bootstrap archive store');
}
// Server continues to start even if archive store failed!
```

**Problem:** If Supabase initialization fails, the server still starts and serves requests, but the archive store will be null, causing runtime errors.

**Impact:** Application will crash at runtime when users try to search or access documents.

**Fix:**
```typescript
} catch (error) {
  logger.error({ err: error }, 'Failed to bootstrap archive store');
  process.exit(1); // Exit if critical service fails
}
```

**Priority:** 🔴 **MUST FIX BEFORE PRODUCTION**

---

### 2. Missing Transaction Safety ⚠️ CRITICAL

**Location:** `src/storage/supabaseArchiveStore.ts:73-121`

**Problem:** `replaceDocumentsAsync` performs multiple operations (delete, upsert, insert) without transaction safety. If any step fails, the database can be left in an inconsistent state.

**Current Flow:**
1. Delete existing documents
2. Upsert archive record
3. Insert new documents in batches

**Issue:** If step 3 fails partway through, documents are deleted but not fully replaced.

**Fix:** Use Supabase RPC function with transaction or implement proper rollback logic:

```typescript
async replaceDocumentsAsync(filename: string, documents: ArchiveDocument[]): Promise<void> {
  // Option 1: Use Supabase RPC with transaction
  const { error } = await this.supabase.rpc('replace_archive_documents', {
    p_filename: filename,
    p_documents: documents.map(doc => ({
      archive_filename: doc.archiveFilename,
      member: doc.member,
      title: doc.title,
      document_date: doc.date,
      content: doc.content,
      relative_path: doc.relativePath
    }))
  });
  
  if (error) {
    throw new Error(`Failed to replace documents: ${error.message}`);
  }
}
```

**Priority:** 🔴 **MUST FIX BEFORE PRODUCTION**

---

### 3. Path Traversal Vulnerability ⚠️ HIGH

**Location:** `src/storage/supabaseArchiveStore.ts:308-319`, `330`

**Problem:** Storage paths are constructed from user-controlled `filename` and `member` parameters without sanitization.

```typescript
const storagePath = `lovdata-documents/${filename}/${member}`;
```

**Attack Vector:** Malicious input like `../../../etc/passwd` could access files outside the intended bucket.

**Fix:** Sanitize paths:

```typescript
import path from 'node:path';

private sanitizeStoragePath(segment: string): string {
  // Remove path traversal attempts
  const normalized = path.normalize(segment).replace(/^(\.\.(\/|\\|$))+/, '');
  // Remove leading slashes and ensure no absolute paths
  return normalized.replace(/^[\/\\]+/, '').replace(/[\/\\]+/g, '/');
}

async readDocumentText(filename: string, member: string): Promise<string | null> {
  const safeFilename = this.sanitizeStoragePath(filename);
  const safeMember = this.sanitizeStoragePath(member);
  const storagePath = `lovdata-documents/${safeFilename}/${safeMember}`;
  // ...
}
```

**Priority:** 🟠 **HIGH - FIX BEFORE PRODUCTION**

---

## High Priority Issues

### 4. Missing Error Handling for `.single()` Queries ⚠️ HIGH

**Location:** Multiple locations using `.single()`

**Problem:** `.single()` throws an error if zero or multiple rows are found. The code doesn't handle the `PGRST116` error code consistently.

**Current Code:**
```typescript
const { data, error } = await this.supabase
  .from('lovdata_documents')
  .select('content')
  .eq('archive_filename', filename)
  .eq('member', member)
  .single();

if (error || !data) {
  return null; // This doesn't distinguish between "not found" and actual errors
}
```

**Fix:**
```typescript
const { data, error } = await this.supabase
  .from('lovdata_documents')
  .select('content')
  .eq('archive_filename', filename)
  .eq('member', member)
  .maybeSingle(); // Use maybeSingle() instead of single()

if (error) {
  this.logs.error({ err: error, filename, member }, 'Failed to fetch document');
  return null;
}

if (!data) {
  return null; // Not found is expected
}

return data.content;
```

**Locations to fix:**
- `getDocumentContentAsync` (line 268-279)
- `getDocumentAsync` (line 288-305)
- `isArchiveProcessedAsync` (line 48-63) - already handles this correctly

**Priority:** 🟠 **HIGH - FIX BEFORE PRODUCTION**

---

### 5. Inefficient Search Query ⚠️ MEDIUM

**Location:** `src/storage/supabaseArchiveStore.ts:171-230`

**Problem:** The search performs two separate queries (count + data fetch) which is inefficient. Also, the count query uses `select('*')` which is unnecessary.

**Current:**
```typescript
// Query 1: Count
const { count, error: countError } = await this.supabase
  .from('lovdata_documents')
  .select('*', { count: 'exact', head: true })
  .textSearch('tsv_content', tsQuery, ...);

// Query 2: Data
const { data, error } = await this.supabase
  .from('lovdata_documents')
  .select('archive_filename, member, title, document_date, content')
  .textSearch('tsv_content', tsQuery, ...)
```

**Fix:** Use a single query with count:

```typescript
// Single query with count
const { data, error, count } = await this.supabase
  .from('lovdata_documents')
  .select('archive_filename, member, title, document_date, content', { count: 'exact' })
  .textSearch('tsv_content', tsQuery, {
    type: 'plain',
    config: 'norwegian'
  })
  .order('id', { ascending: true })
  .range(options.offset, options.offset + options.limit - 1);

if (error) {
  this.logs.error({ err: error, query }, 'Failed to search documents');
  return { hits: [], total: 0 };
}

const total = count ?? 0;
```

**Priority:** 🟡 **MEDIUM - OPTIMIZE FOR PRODUCTION**

---

### 6. Missing Input Validation ⚠️ MEDIUM

**Location:** `src/storage/supabaseArchiveStore.ts`

**Problem:** No validation of input parameters (filename, member, query) before database operations.

**Fix:** Add input validation:

```typescript
private validateFilename(filename: string): void {
  if (!filename || typeof filename !== 'string' || filename.length === 0) {
    throw new Error('Filename must be a non-empty string');
  }
  if (filename.length > 255) {
    throw new Error('Filename too long');
  }
}

async getDocumentAsync(filename: string, member: string): Promise<ArchiveDocumentRecord | null> {
  this.validateFilename(filename);
  if (!member || typeof member !== 'string' || member.length === 0) {
    throw new Error('Member must be a non-empty string');
  }
  // ... rest of method
}
```

**Priority:** 🟡 **MEDIUM - ADD FOR PRODUCTION**

---

## Medium Priority Issues

### 7. Search Query Token Sanitization ⚠️ LOW-MEDIUM

**Location:** `src/storage/supabaseArchiveStore.ts:179`

**Current:** Tokens are extracted and joined directly into tsquery:
```typescript
const tsQuery = tokens.map(token => `${token}:*`).join(' & ');
```

**Analysis:** The `extractQueryTokens` function already sanitizes tokens (only alphanumeric, min 3 chars), so this is relatively safe. However, consider escaping special tsquery characters.

**Recommendation:** Current implementation is acceptable, but document the safety assumption.

**Priority:** 🟢 **LOW - DOCUMENT OR ENHANCE**

---

### 8. Missing Timeout Configuration ⚠️ MEDIUM

**Location:** `src/services/supabaseClient.ts`

**Problem:** No timeout configured for Supabase client. Long-running queries could hang indefinitely.

**Fix:**
```typescript
adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'x-client-info': 'lovdata-backend'
    }
  }
});
```

Consider adding request timeout wrapper or using Supabase's built-in timeout.

**Priority:** 🟡 **MEDIUM - ADD FOR PRODUCTION**

---

### 9. Fire-and-Forget in `startArchiveIngest` ⚠️ MEDIUM

**Location:** `src/storage/supabaseArchiveStore.ts:135-145`

**Problem:** The `finalize()` method uses fire-and-forget pattern which can silently fail.

**Current:**
```typescript
const finalize = () => {
  // ...
  this.replaceDocumentsAsync(filename, documents).catch(error => {
    this.logs.error({ err: error, archive: filename }, 'Failed to finalize archive ingest');
  });
};
```

**Issue:** Errors are logged but not propagated. Callers can't know if finalization succeeded.

**Recommendation:** Document this behavior clearly, or consider making the session async-aware.

**Priority:** 🟡 **MEDIUM - DOCUMENT OR REFACTOR**

---

### 10. Duplicate Query in `readDocumentText` ⚠️ LOW

**Location:** `src/storage/supabaseArchiveStore.ts:321-344`

**Problem:** `readDocumentText` calls `getDocumentAsync` which queries the database, then if that fails, queries storage. However, `getDocumentAsync` already queries the database, so we're doing redundant work.

**Current:**
```typescript
async readDocumentText(filename: string, member: string): Promise<string | null> {
  const record = await this.getDocumentAsync(filename, member); // Query 1
  if (record) {
    return record.content;
  }
  // Fallback to storage...
}
```

**Optimization:** This is actually fine - it's a fallback pattern. But consider caching the database result.

**Priority:** 🟢 **LOW - ACCEPTABLE AS IS**

---

## Code Quality Issues

### 11. Missing JSDoc Documentation ⚠️ LOW

**Location:** All public methods in `SupabaseArchiveStore`

**Recommendation:** Add JSDoc comments for public methods:

```typescript
/**
 * Searches documents using full-text search with Norwegian language configuration.
 * 
 * @param query - Search query string (will be tokenized and sanitized)
 * @param options - Search options with limit and offset for pagination
 * @returns Promise resolving to search results with hits and total count
 * @throws Never throws, returns empty results on error
 */
async searchAsync(query: string, options: { limit: number; offset: number }): Promise<ArchiveSearchResult> {
  // ...
}
```

**Priority:** 🟢 **LOW - NICE TO HAVE**

---

### 12. Type Safety: Optional Chaining ⚠️ LOW

**Location:** `src/storage/supabaseArchiveStore.ts:218`

**Current:**
```typescript
const hits: ArchiveSearchHit[] = (data ?? []).map(doc => {
```

**Analysis:** Good defensive programming. This is fine.

**Priority:** 🟢 **LOW - ACCEPTABLE**

---

## Positive Observations ✅

1. **Good Error Logging:** Comprehensive error logging with context
2. **Type Safety:** Strong TypeScript usage throughout
3. **Separation of Concerns:** Clean separation between storage and business logic
4. **Environment Validation:** Good use of Zod for env validation
5. **Singleton Pattern:** Proper use of singleton for Supabase client
6. **Query Token Extraction:** Safe token extraction with regex filtering
7. **Batch Processing:** Documents are inserted in batches (500) to avoid memory issues

---

## Recommendations Summary

### Must Fix Before Production:
1. ✅ Exit server if Supabase initialization fails
2. ✅ Add transaction safety to `replaceDocumentsAsync`
3. ✅ Sanitize storage paths to prevent path traversal
4. ✅ Use `maybeSingle()` instead of `single()` for better error handling

### Should Fix for Production:
5. ✅ Optimize search to use single query with count
6. ✅ Add input validation for all public methods
7. ✅ Add timeout configuration for Supabase client

### Nice to Have:
8. ✅ Document fire-and-forget behavior in `startArchiveIngest`
9. ✅ Add JSDoc comments for public APIs
10. ✅ Consider adding request retry logic for transient failures

---

## Testing Recommendations

Before production deployment, ensure:

1. **Integration Tests:**
   - Test Supabase connection failure scenarios
   - Test partial batch insert failures
   - Test path traversal attempts
   - Test search with various query formats

2. **Load Tests:**
   - Test search performance with large result sets
   - Test concurrent document reads
   - Test batch insert performance

3. **Error Scenario Tests:**
   - Test behavior when Supabase is unavailable
   - Test behavior with malformed queries
   - Test behavior with invalid storage paths

---

## Security Checklist

- [ ] ✅ Path traversal protection added
- [ ] ✅ Input validation implemented
- [ ] ✅ Error messages don't expose sensitive info
- [ ] ✅ SQL injection protection (tsquery is safe)
- [ ] ⚠️ Transaction safety needed
- [ ] ⚠️ Timeout configuration needed

---

## Performance Checklist

- [ ] ⚠️ Search query optimization needed
- [ ] ✅ Batch processing implemented
- [ ] ✅ Proper indexing (GIN index on tsv_content)
- [ ] ⚠️ Consider query result caching
- [ ] ⚠️ Consider connection pooling

---

## Conclusion

The codebase is **well-structured** and shows **good engineering practices**. However, **4 critical issues must be fixed** before production:

1. Server startup failure handling
2. Transaction safety
3. Path traversal protection
4. Error handling for single queries

Once these are addressed, the code will be **production-ready**.

**Estimated Fix Time:** 2-4 hours

**Risk Level:** 🟠 **Medium-High** (without fixes) → 🟢 **Low** (with fixes)

