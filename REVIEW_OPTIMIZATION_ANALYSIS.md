# Code Review: Embeddings and Tool Usage Optimization

## Executive Summary

The codebase implements a hybrid RAG system with:
- **Hybrid Search**: Combines Full-Text Search (FTS) + Vector Search using RRF
- **Chunk-based Retrieval**: Searches at chunk level for better granularity
- **Agent-driven Tool Calling**: OpenAI agent calls search functions directly

## ✅ Strengths

### 1. Hybrid Search Implementation
- ✅ Uses **Reciprocal Rank Fusion (RRF)** to combine FTS and vector search results
- ✅ Falls back to FTS-only if embeddings unavailable
- ✅ Searches at **chunk level** (better granularity than document-level)
- ✅ Query embeddings generated using `text-embedding-3-small` (1536 dimensions)

### 2. Embeddings Infrastructure
- ✅ Embeddings generated for both documents and chunks during ingestion
- ✅ Chunks inherit metadata (law_type, year, ministry) from parent documents
- ✅ Embedding service properly configured with batching support

### 3. Agent Tool Calling
- ✅ Agent has clear function schemas with good descriptions
- ✅ Supports multiple iterations (max 5) for complex queries
- ✅ Prioritized search implemented for law_type filtering

## 📊 Current Status

### Embeddings Coverage
- ✅ **Documents**: 100% have law_type (41,934 documents)
- ✅ **Chunks**: 89.4% have law_type (53,512 of 59,841 chunks)
- ⚠️ **Chunk Embeddings**: 78.2% have embeddings (46,808 of 59,841 chunks)
  - **13,033 chunks missing embeddings** - these will fall back to FTS-only search

### Search Performance
- Hybrid search (FTS + Vector) with RRF is correctly implemented
- Falls back gracefully to FTS-only when embeddings unavailable
- Uses chunk-level search for better granularity

## ⚠️ Potential Issues & Optimizations

### Issue 1: Sequential Prioritized Search Inefficiency

**Current Implementation:**
```typescript
// In lovdata-api/index.ts:89-114
for (const lawType of defaultLawTypePriority) {
  const typeResult = await searchLovdataPublicData({...});
  // Tries each type sequentially until enough results
}
```

**Problem:**
- Makes up to 6 sequential database queries (one per law type)
- Each query generates a query embedding and runs hybrid search
- Slow when none of the first types have results

**Recommendation:**
1. **Option A**: Do one search without law_type filter, then filter/prioritize results client-side
2. **Option B**: Use SQL `ORDER BY CASE WHEN law_type = 'Lov' THEN 1...` to prioritize in single query
3. **Option C**: Search Lov + Forskrift in parallel (they're highest priority anyway)

### Issue 2: Query Embedding Regeneration

**Current Implementation:**
```typescript
// In supabaseArchiveStore.ts:494
queryEmbedding = await this.embeddingService.generateEmbedding(query);
// Called for EACH search in prioritized search
```

**Problem:**
- Query embedding generated multiple times for same query in prioritized search
- Unnecessary API calls to OpenAI embedding service

**Recommendation:**
- Cache query embeddings for the duration of the prioritized search loop
- Or generate once before the loop and reuse

### Issue 3: Agent Tool Calling Strategy

**Current Behavior:**
- Agent may call tools multiple times
- No caching of previous search results
- Agent might re-search with same query if it doesn't understand results

**Potential Improvements:**
1. Track search history and prevent duplicate searches
2. Improve function result formatting to help agent understand results better
3. Add context about what was already searched

### Issue 4: Chunk Embeddings Coverage ⚠️ **CRITICAL**

**Current Status:**
- ✅ 100% documents have law_type
- ✅ 89.4% chunks have law_type  
- ⚠️ **78.2% chunks have embeddings (13,033 chunks missing)**

**Impact:**
- Chunks without embeddings will fall back to FTS-only search
- May reduce search quality for those chunks
- Vector search component of hybrid search won't work for missing embeddings

**Recommendation:**
- **HIGH PRIORITY**: Backfill embeddings for the 13,033 chunks missing embeddings
- This will improve hybrid search quality significantly
- Can use similar approach to `backfillLawTypes.ts` script

### Issue 5: RRF Configuration

**Current:**
```typescript
rrf_k: 60  // RRF constant
```

**Analysis:**
- k=60 is reasonable but could be tuned
- Typical values: k=20-60
- Lower k = more weight to top results, higher k = more balanced

**Recommendation:**
- Consider tuning based on search quality metrics
- Could make configurable via environment variable

## 🎯 Specific Recommendations

### High Priority

1. **Backfill Chunk Embeddings** ⚠️ **CRITICAL**
   - 13,033 chunks (21.8%) are missing embeddings
   - Without embeddings, these chunks can't use vector search (hybrid search degraded)
   - Create backfill script similar to `backfillLawTypes.ts`
   - Target: 100% embedding coverage for optimal RAG performance

2. **Optimize Prioritized Search**
   - Generate query embedding **once** before the prioritized search loop
   - Currently regenerates embedding for each law_type (up to 6 times)
   - Consider parallel search for Lov + Forskrift (top 2 priorities) to reduce latency
   - Add early termination if no results found in first 2 types

3. **Cache Query Embeddings**
   - Implement in-memory cache for query embeddings (TTL: 5-10 minutes)
   - Reduces redundant OpenAI API calls across different agent tool calls
   - Can cache by query string hash

### Medium Priority

4. **Improve Agent Guidance**
   - Add better function result formatting to help agent understand when to search more
   - Include result quality hints (e.g., "Found 0 results, try different law type")

5. **Optimize RRF Parameters**
   - Make rrf_k configurable
   - Consider different k values for different query types

6. **Search Result Deduplication**
   - If agent searches multiple times with similar queries, deduplicate results
   - Track search history in function results

### Low Priority

7. **Fine-tune Hybrid Search Balance**
   - Consider weighting FTS vs Vector search differently based on query type
   - Legal queries might benefit from higher FTS weight (exact term matching)

8. **Add Search Analytics**
   - Track which law types are most commonly searched
   - Monitor search result quality metrics

## Code Quality Observations

### ✅ Good Practices
- Proper error handling and fallbacks
- Good logging for debugging
- Timeout protection to prevent hanging
- Type safety with TypeScript

### 🔧 Areas for Improvement
- Some duplicate code in prioritized search
- Could extract common search logic
- Function result formatting could be more structured

## Testing Recommendations

1. **Verify Embeddings Coverage**
   ```sql
   SELECT 
     COUNT(*) as total_chunks,
     COUNT(embedding) as chunks_with_embedding,
     COUNT(*) - COUNT(embedding) as chunks_without_embedding
   FROM document_chunks;
   ```

2. **Test Hybrid Search Performance**
   - Compare FTS-only vs Hybrid search quality
   - Measure query latency
   - Test with various query types

3. **Monitor Agent Tool Usage**
   - Track number of function calls per query
   - Measure time spent in search vs generation
   - Analyze which searches yield best results

## Conclusion

The implementation is **solid and well-architected**. The hybrid search with RRF is correctly implemented and leverages embeddings effectively when available.

### Key Findings:

✅ **Strengths:**
- Hybrid search (FTS + Vector) with RRF correctly implemented
- Chunk-level search provides better granularity
- Agent tool calling architecture is well-designed
- Good error handling and fallbacks

⚠️ **Critical Issue:**
- **21.8% of chunks (13,033 chunks) are missing embeddings**
- This degrades hybrid search quality for those chunks (fallback to FTS-only)
- **RECOMMENDATION**: Backfill embeddings to achieve 100% coverage

🔧 **Optimization Opportunities:**
1. **Prioritized search efficiency** - Sequential searches regenerate query embeddings (can cache)
2. **Query embedding caching** - Redundant OpenAI API calls across search iterations
3. **Parallel search** - Could search Lov + Forskrift in parallel to reduce latency

### Priority Actions:

1. **HIGH**: Backfill chunk embeddings (13,033 chunks)
2. **MEDIUM**: Optimize prioritized search to cache query embeddings
3. **MEDIUM**: Consider parallel search for top-priority law types

With these optimizations, the system will achieve optimal RAG performance leveraging the full power of embeddings.

