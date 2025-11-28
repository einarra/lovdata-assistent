# Hybrid Search Implementation

This document describes the implementation of hybrid search (vector + keyword) with Reciprocal Rank Fusion (RRF) for the Lovdata Assistant.

## Overview

The hybrid search combines:
- **Full-Text Search (FTS)**: Keyword-based search using PostgreSQL's `tsvector` for precise term matching
- **Vector Search**: Semantic search using OpenAI embeddings to find documents with similar meaning
- **Reciprocal Rank Fusion (RRF)**: Merges results from both search methods to provide the best of both worlds

## Why Hybrid Search?

**Problem**: Pure keyword search misses relevant documents that use different terminology.
- Example: Searching for "termination" won't find documents using "dismissal"

**Solution**: Hybrid search combines:
- **Precision** of keyword search (exact term matches)
- **Understanding** of semantic search (conceptual similarity)

## Implementation Details

### 1. Database Schema

The migration adds:
- `pgvector` extension for vector operations
- `embedding` column (vector(1536)) to `lovdata_documents` table
- HNSW index on `embedding` column for fast similarity search
- `search_lovdata_documents_hybrid()` function for hybrid search with RRF

**Migration File**: `backend/supabase/migrations/add_vector_search.sql`

### 2. Embedding Generation

**Service**: `backend/src/services/embeddingService.ts`

- Uses OpenAI's `text-embedding-3-small` model (1536 dimensions)
- Generates embeddings during document ingestion
- Batch processing for efficiency (100 documents per batch by default)

**Model**: `text-embedding-3-small`
- Cost-effective
- 1536 dimensions
- Good performance for legal documents

### 3. Document Ingestion

**Updated**: `backend/src/storage/supabaseArchiveStore.ts`

- Automatically generates embeddings when documents are inserted
- Falls back gracefully if embedding generation fails (documents inserted without embeddings)
- Embeddings stored alongside document content

### 4. Search Implementation

**Updated**: `backend/src/storage/supabaseArchiveStore.ts::searchAsync()`

**Behavior**:
1. If embeddings are available:
   - Generates query embedding
   - Calls `search_lovdata_documents_hybrid()` RPC function
   - Uses RRF to combine FTS and vector search results
2. If embeddings are not available:
   - Falls back to FTS-only search using existing `search_lovdata_documents()` function

## RRF Algorithm

Reciprocal Rank Fusion combines rankings from multiple search methods:

```
RRF_score(d) = Σ (1 / (k + rank_i(d)))
```

Where:
- `rank_i(d)` = rank of document `d` in result set `i`
- `k` = constant (default: 60) to dampen lower-ranked results
- Sum is over all result sets (FTS and Vector)

**Example**:
- Document appears at rank 1 in FTS: score = 1/(60+1) = 0.0164
- Document appears at rank 3 in Vector: score = 1/(60+3) = 0.0159
- Combined RRF score: 0.0323

## Setup Instructions

### 1. Apply Database Migration

Run the migration SQL in your Supabase SQL editor:

```bash
# Option 1: Via Supabase Dashboard
# 1. Go to SQL Editor
# 2. Copy contents of backend/supabase/migrations/add_vector_search.sql
# 3. Execute

# Option 2: Via Supabase CLI (if configured)
supabase db push
```

### 2. Verify pgvector Extension

```sql
-- Check if extension is enabled
SELECT * FROM pg_extension WHERE extname = 'vector';
```

### 3. Verify Embedding Column

```sql
-- Check if embedding column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'lovdata_documents' 
AND column_name = 'embedding';
```

### 4. Regenerate Embeddings for Existing Documents

If you have existing documents without embeddings, you'll need to regenerate them:

```typescript
// This will be done automatically for new documents
// For existing documents, you may need to re-ingest archives
// or create a migration script to backfill embeddings
```

**Note**: Generating embeddings for 41,934 existing documents will:
- Take time (batch processing)
- Cost money (OpenAI API usage)
- Consider running during off-peak hours

### 5. Test Hybrid Search

```sql
-- Test the hybrid search function
SELECT * FROM search_lovdata_documents_hybrid(
  'arbeidsforhold oppsigelse',  -- search query
  (SELECT embedding FROM lovdata_documents WHERE id = 1 LIMIT 1),  -- query embedding
  10,  -- limit
  0,   -- offset
  60   -- RRF k constant
);
```

## Configuration

### Environment Variables

- `OPENAI_API_KEY`: Required for embedding generation
- Embeddings are enabled by default if `OPENAI_API_KEY` is set

### Disable Embeddings

To disable embedding generation (FTS-only search):

```typescript
const store = new SupabaseArchiveStore({ 
  enableEmbeddings: false 
});
```

## Performance Considerations

### Indexing

- HNSW index on `embedding` column provides fast similarity search
- GIN index on `tsv_content` provides fast full-text search
- Both indexes are used in hybrid search

### Query Performance

- Hybrid search is slightly slower than FTS-only (adds vector similarity computation)
- Typical query time: 100-500ms (depending on dataset size)
- RRF computation is efficient (O(n) where n = result set size)

### Embedding Generation

- Batch processing: 100 documents per batch (configurable)
- API rate limits: OpenAI allows up to 2048 inputs per request
- Cost: ~$0.02 per 1M tokens (text-embedding-3-small)

## Monitoring

### Check Embedding Coverage

```sql
-- Percentage of documents with embeddings
SELECT 
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) * 100.0 / COUNT(*) as coverage_percent
FROM lovdata_documents;
```

### Monitor Search Performance

Check logs for:
- `generate_query_embedding`: Time to generate query embedding
- `db_search`: Total search time
- `useHybridSearch`: Whether hybrid search was used

## Troubleshooting

### Embeddings Not Generated

**Symptoms**: Documents inserted without embeddings

**Causes**:
1. `OPENAI_API_KEY` not set
2. OpenAI API error during generation
3. Embedding service initialization failed

**Solution**: Check logs for embedding generation errors

### Hybrid Search Not Used

**Symptoms**: Only FTS results returned

**Causes**:
1. No embeddings in database
2. Query embedding generation failed
3. Embedding service not initialized

**Solution**: Verify embeddings exist and check logs

### RPC Function Not Found

**Symptoms**: `search_lovdata_documents_hybrid` function not found error

**Solution**: Run the migration SQL to create the function

## Future Improvements

1. **Backfill Script**: Create script to generate embeddings for existing documents
2. **Caching**: Cache query embeddings for repeated searches
3. **Tuning**: Experiment with RRF `k` parameter for optimal results
4. **Analytics**: Track search performance and result quality
5. **A/B Testing**: Compare hybrid vs FTS-only search quality

## References

- [Supabase pgvector Documentation](https://supabase.com/docs/guides/database/extensions/pgvector)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)

