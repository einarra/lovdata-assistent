# Supabase Migration Review

**Date:** 2025-11-12  
**Status:** Data migrated, application code still uses SQLite

## ✅ What's Working

### 1. Supabase Infrastructure
- ✅ **Supabase Client Setup** (`src/services/supabaseClient.ts`)
  - Correctly configured with service role key
  - Singleton pattern implemented
  - Used for authentication (middleware, session endpoints)

### 2. Database Schema
- ✅ **Postgres Tables Created** (`supabase/schema.sql`)
  - `lovdata_archives` - Archive metadata
  - `lovdata_documents` - Document content with full-text search (`tsvector`)
  - Proper indexes, foreign keys, RLS policies
  - Timestamp triggers configured

### 3. Data Migration
- ✅ **41,934 documents** successfully imported to Supabase
- ✅ **4 archives** registered in `lovdata_archives`
- ✅ **Storage buckets** populated (`lovdata-archives`, `lovdata-documents`)
- ✅ Migration scripts tested and working

### 4. Authentication
- ✅ **Supabase Auth** fully integrated
- ✅ JWT verification working (`requireSupabaseAuth` middleware)
- ✅ User session endpoints using Supabase

## ❌ What's NOT Connected

### 1. ArchiveStore Still Uses SQLite
**Current State:**
- `src/storage/archiveStore.ts` - Still implements SQLite-based storage
- `src/index.ts` - Bootstraps SQLite `ArchiveStore` on startup
- All search/document retrieval uses local SQLite database

**Impact:**
- Application reads from local `data/lovdata.db` instead of Supabase
- Full-text search uses SQLite FTS5 instead of Postgres `tsvector`
- Document content read from local filesystem instead of Supabase Storage

### 2. No Supabase ArchiveStore Implementation
**Missing:**
- No `SupabaseArchiveStore` class that implements the same interface
- No abstraction layer to switch between SQLite and Supabase
- No configuration flag to choose data source

### 3. Search Functionality
**Current:** Uses SQLite FTS5 (`documents_fts` virtual table)  
**Should Use:** Postgres `tsvector` with GIN index (already in schema)

**Code Location:**
- `src/storage/archiveStore.ts:205-238` - `search()` method uses SQLite FTS
- `src/services/lovdataSearch.ts` - Wraps ArchiveStore search

### 4. Document Retrieval
**Current:** Reads from local filesystem (`data/archives/...`)  
**Should Use:** Supabase Storage buckets (`lovdata-documents/...`)

**Code Locations:**
- `src/storage/archiveStore.ts:281-296` - `readDocumentText()` reads local files
- `src/http/app.ts:173-179` - Falls back to local archive store

### 5. Archive Ingest Still Writes to SQLite
**Current:** `bootstrapArchiveStore()` creates SQLite database  
**Should:** Write to Supabase when configured

**Code Location:**
- `src/services/archiveIngestor.ts:21-88` - Creates SQLite ArchiveStore

## 🔧 Required Changes

### Priority 1: Create Supabase ArchiveStore
1. Create `src/storage/supabaseArchiveStore.ts`
   - Implement same interface as `ArchiveStore`
   - Use Supabase client for queries
   - Use Postgres `tsvector` for full-text search
   - Read documents from Supabase Storage

2. Update search to use Postgres:
   ```sql
   SELECT ... FROM lovdata_documents 
   WHERE tsv_content @@ to_tsquery('norwegian', ?)
   ORDER BY ts_rank(tsv_content, to_tsquery('norwegian', ?)) DESC
   ```

### Priority 2: Add Configuration Toggle
1. Add `USE_SUPABASE_STORAGE` env variable
2. Update `src/index.ts` to choose implementation:
   ```typescript
   if (env.USE_SUPABASE_STORAGE) {
     archiveStore = new SupabaseArchiveStore();
   } else {
     archiveStore = await bootstrapArchiveStore(services.lovdata);
   }
   ```

### Priority 3: Update Document Retrieval
1. Replace local file reads with Supabase Storage API
2. Use signed URLs or direct bucket access
3. Update `readDocumentText()` to fetch from Storage

### Priority 4: Update Archive Ingest
1. Make `archiveIngestor` write to Supabase when configured
2. Or create separate `supabaseArchiveIngestor.ts`

## 📋 Migration Checklist

- [x] Supabase project created and configured
- [x] Database schema deployed
- [x] Storage buckets created
- [x] Data exported from SQLite
- [x] Data imported to Supabase Postgres
- [x] Files uploaded to Supabase Storage
- [ ] **SupabaseArchiveStore implementation created**
- [ ] **Search migrated to Postgres full-text**
- [ ] **Document retrieval migrated to Storage**
- [ ] **Configuration toggle added**
- [ ] **Application updated to use Supabase**
- [ ] **Integration tests updated**
- [ ] **Documentation updated**

## 🚨 Critical Issues

1. **Application is NOT using Supabase data** - Still reading from SQLite
2. **No way to switch** - Hardcoded to SQLite implementation
3. **Search performance** - Using local SQLite instead of optimized Postgres
4. **Storage not utilized** - Files uploaded but not accessed via API

## 💡 Recommendations

1. **Immediate:** Create `SupabaseArchiveStore` as parallel implementation
2. **Short-term:** Add feature flag to switch between implementations
3. **Long-term:** Remove SQLite dependency once Supabase is validated
4. **Testing:** Run both implementations in parallel during transition

## 📝 Next Steps

1. Implement `SupabaseArchiveStore` class
2. Add environment variable for storage backend selection
3. Update bootstrap logic in `src/index.ts`
4. Test search and document retrieval with Supabase
5. Update integration tests
6. Deploy and monitor

