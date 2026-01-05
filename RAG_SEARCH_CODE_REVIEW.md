# RAG Search Logic Code Review

## Executive Summary

This code review examines the RAG (Retrieval-Augmented Generation) search system, focusing on:
1. How the agent uses search functions
2. Embedding generation and hybrid search optimization
3. Database query efficiency
4. Search result retrieval accuracy

## Architecture Overview

The system uses a **hybrid search** approach combining:
- **Full-Text Search (FTS)**: PostgreSQL `tsvector` for keyword matching
- **Vector Search**: OpenAI embeddings for semantic similarity
- **Reciprocal Rank Fusion (RRF)**: Merges results from both methods

Search flow:
```
Agent → Function Call → Skill (lovdata-api) → searchLovdataPublicData → SupabaseArchiveStore.searchAsync → Database RPC
```

## Critical Issues Found

### 🔴 Issue 1: Missing Embedding Generation When LawType is Specified

**Location**: `backend/src/skills/lovdata-api/index.ts:221-229`

**Problem**: When the agent specifies a `lawType` filter, the skill does NOT generate query embeddings, causing the system to fall back to FTS-only search instead of using hybrid search.

```typescript
} else {
  // Law type specified, use normal search
  searchResult = await searchLovdataPublicData({
    store: archiveStore,
    query: command.query,
    page,
    pageSize,
    filters: command.filters
    // ❌ queryEmbedding is NOT passed here
  });
}
```

**Impact**: 
- Hybrid search (vector + keyword) is only used when `lawType` is NOT specified
- When agent explicitly requests a specific document type, search quality degrades
- Wastes the hybrid search infrastructure for a common use case

**Recommendation**: Generate embeddings for all searches, not just prioritized searches:

```typescript
// Generate query embedding once for all searches
let queryEmbedding: number[] | null = null;
try {
  const embeddingService = (archiveStore as any).embeddingService as EmbeddingService | null;
  if (embeddingService) {
    queryEmbedding = await embeddingService.generateEmbedding(command.query);
  }
} catch (embeddingError) {
  logger.warn({ err: embeddingError }, 'Failed to generate query embedding');
}

// Use in both prioritized and non-prioritized searches
searchResult = await searchLovdataPublicData({
  store: archiveStore,
  query: command.query,
  page,
  pageSize,
  filters: command.filters,
  queryEmbedding // ✅ Always pass embedding
});
```

---

### 🟡 Issue 2: Type Safety Violation for EmbeddingService Access

**Location**: `backend/src/skills/lovdata-api/index.ts:90`

**Problem**: The skill accesses `embeddingService` using a type cast hack:

```typescript
const embeddingService = (archiveStore as any).embeddingService as EmbeddingService | null;
```

**Impact**:
- No compile-time type safety
- Harder to maintain and refactor
- Could break if internal structure changes

**Recommendation**: Add a proper accessor method to `SupabaseArchiveStore`:

```typescript
// In SupabaseArchiveStore class
getEmbeddingService(): EmbeddingService | null {
  return this.embeddingService;
}
```

Then use it:
```typescript
const embeddingService = archiveStore.getEmbeddingService();
```

---

### 🟡 Issue 3: Inaccurate Count Query for Chunk-Based Search

**Location**: `backend/src/storage/supabaseArchiveStore.ts:625-643`

**Problem**: When using chunk-based hybrid search (`search_document_chunks_hybrid`), the count query still queries the `lovdata_documents` table instead of counting distinct documents from chunks.

```typescript
// Searching chunks but counting documents - mismatch!
let countQueryBuilder = this.supabase
  .from('lovdata_documents')  // ❌ Wrong table for chunk search
  .select('id', { count: 'exact', head: true })
  .textSearch('tsv_content', tsQuery, {
    type: 'plain',
    config: 'norwegian'
  });
```

**Impact**:
- Total count may be inaccurate when searching chunks
- Pagination calculations could be wrong
- User sees incorrect "total results" numbers

**Recommendation**: Create a count query that matches the chunk search:

```typescript
// For chunk-based search, count distinct documents from matching chunks
if (rpcFunctionName === 'search_document_chunks_hybrid') {
  // Count distinct documents that have matching chunks
  const countQuery = `
    SELECT COUNT(DISTINCT document_id) as count
    FROM (
      SELECT DISTINCT c.document_id
      FROM public.document_chunks c
      WHERE (${ftsQuery ? `c.tsv_content @@ to_tsquery('norwegian', $1)` : 'TRUE'})
        AND (${options.filters?.year ? `c.year = ${options.filters.year}` : 'TRUE'})
        AND (${options.filters?.lawType ? `c.law_type = '${options.filters.lawType}'` : 'TRUE'})
        AND (${options.filters?.ministry ? `c.ministry = '${options.filters.ministry}'` : 'TRUE'})
        ${queryEmbedding ? 'AND c.embedding IS NOT NULL' : ''}
    ) as matching_docs
  `;
  // Execute count query
} else {
  // Use existing document count for document-level search
}
```

Alternatively, modify the RPC function to return the count directly.

---

### 🟢 Issue 4: Embedding Generation Happens Twice (Minor Optimization)

**Location**: `backend/src/storage/supabaseArchiveStore.ts:493-507`

**Problem**: If the skill generates an embedding and passes it, but then `searchAsync` doesn't receive it properly, it will generate it again. However, the code does check for `options.queryEmbedding` first, so this is mostly fine.

**Current Flow**:
1. Skill generates embedding (if prioritized search)
2. Passes to `searchLovdataPublicData`
3. Which passes to `store.searchAsync`
4. `searchAsync` checks `options.queryEmbedding` first ✅

**Status**: This is actually working correctly. The embedding is only generated once when passed through the chain.

---

## Positive Findings ✅

### 1. Embedding Reuse in Prioritized Search
The skill correctly generates embeddings once and reuses them across multiple searches when trying different law types (lines 86-97, 118, 130, 174, 217). This is an excellent optimization.

### 2. Hybrid Search Fallback
The system gracefully falls back to FTS-only search if embedding generation fails (lines 500-504 in `supabaseArchiveStore.ts`).

### 3. Chunk-Based Search
The system uses chunk-based search for better granularity, which is superior to document-level search for RAG.

### 4. Agent Function Usage
The agent correctly uses the search function with appropriate parameters. The function schema is well-defined and guides the agent properly.

### 5. Timeout Protection
Excellent timeout handling at multiple levels (30s internal, 60s external) prevents hanging queries.

---

## Recommendations Summary

### High Priority
1. **Fix embedding generation for specified lawType searches** - This significantly impacts search quality
2. **Fix count query for chunk-based search** - Ensures accurate pagination

### Medium Priority
3. **Add proper type-safe accessor for embeddingService** - Improves maintainability
4. **Consider adding count to RPC function return** - Simplifies count logic

### Low Priority
5. **Add metrics/logging for hybrid vs FTS-only search usage** - Helps monitor optimization effectiveness
6. **Consider caching embeddings for identical queries** - Further optimization

---

## Testing Recommendations

1. **Test hybrid search with lawType specified**: Verify embeddings are generated and hybrid search is used
2. **Test count accuracy**: Compare chunk search counts with document search counts for same query
3. **Test embedding reuse**: Verify embeddings are only generated once in prioritized search flow
4. **Test fallback behavior**: Ensure FTS-only search works when embeddings fail

---

## Code Quality Notes

- **Logging**: Comprehensive logging throughout, which is excellent for debugging
- **Error Handling**: Good error handling with graceful fallbacks
- **Type Safety**: Some areas use `any` type casts that could be improved
- **Documentation**: Code comments are helpful but could be more comprehensive in some areas

---

## Agent Search Function Usage Analysis

### ✅ Agent Usage is Correct

The agent correctly uses the search function:

1. **Function Calling**: Agent properly calls `search_lovdata_legal_documents` with appropriate parameters (query, lawType, year, ministry, page, pageSize)

2. **Result Processing**: 
   - Results are correctly converted from skill output to evidence format
   - Evidence is deduplicated by (filename, member) to avoid duplicates
   - Evidence is accumulated across multiple function calls

3. **Evidence Flow**:
   ```
   Database → Skill Result → Evidence → Agent → Answer
   ```
   The flow is working correctly - the agent DOES get answers from the database.

4. **Function Results**: Results are properly formatted with guidance messages to help the agent understand search outcomes

### Agent Search Optimization

The agent is using the search function optimally:
- ✅ Extracts relevant search terms from user questions
- ✅ Uses appropriate filters (lawType, year, ministry) when mentioned
- ✅ Can make multiple searches in sequence to gather comprehensive evidence
- ✅ Handles pagination correctly

### Potential Agent Improvements

1. **Query Quality**: The agent could potentially improve query extraction, but this is more of a prompt engineering issue than a code issue

2. **Search Strategy**: The agent could be guided to:
   - Try broader searches first, then narrow down
   - Use both search functions (legal documents + legal practice) more systematically
   - Better handle cases where initial searches return few results

---

## Conclusion

The RAG search system is well-architected with hybrid search, chunking, and RRF. The agent correctly uses the search functions and receives results from the database. However, there are two critical issues:

1. **Embedding generation is skipped when lawType is specified**, causing suboptimal search quality
2. **Count queries don't match chunk-based search**, potentially causing pagination issues

Fixing these issues will significantly improve search quality and accuracy. The agent's usage of the search function is correct and optimal.

