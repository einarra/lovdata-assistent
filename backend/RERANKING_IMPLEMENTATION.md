# Re-ranking Implementation

This document describes the implementation of re-ranking for search results to improve relevance.

## Overview

Re-ranking improves search result quality by using a specialized model (Cohere Rerank) to re-order candidates based on semantic relevance to the query. This addresses the limitation of basic term-frequency ranking (`ts_rank`) which doesn't understand query meaning.

## Why Re-ranking?

**Problem**: `ts_rank` is basic - it only considers term frequency, not semantic meaning. It will miss relevant documents that use different terminology.

**Solution**: Re-ranking provides:
- **Semantic Understanding**: Understands query meaning, not just keywords
- **Better Top Results**: Most relevant documents appear first
- **Improved Context**: Better results in the context window for the LLM

## Implementation Details

### 1. Re-ranking Service

**File**: `backend/src/services/rerankService.ts`

- Uses Cohere Rerank API (`rerank-multilingual-v3.0` model)
- Supports Norwegian and 100+ languages
- Re-ranks up to 100 candidates per request
- Returns results sorted by relevance score

**Features**:
- Handles empty/invalid candidates gracefully
- Error handling with fallback to original results
- Configurable top N results
- Preserves metadata from original candidates

### 2. Search Integration

**Updated**: `backend/src/services/lovdataSearch.ts`

**Process**:
1. Retrieve larger candidate set (default: 50) from hybrid search
2. Re-rank candidates using Cohere Rerank
3. Apply pagination to re-ranked results
4. Return top N re-ranked results (default: 5-10)

**Configuration**:
- `enableReranking`: Enable/disable re-ranking (default: true if COHERE_API_KEY is set)
- `rerankTopN`: Number of candidates to retrieve (default: 50)

### 3. Environment Configuration

**Added to**: `backend/src/config/env.ts`

- `COHERE_API_KEY`: Cohere API key (required for re-ranking)
- `COHERE_BASE_URL`: Cohere API base URL (default: https://api.cohere.ai/v1)
- `ENABLE_RERANKING`: Enable/disable re-ranking (default: true)

## Usage

### Setup

1. **Get Cohere API Key**:
   - Sign up at https://cohere.com
   - Get API key from dashboard
   - Add to `.env` file:
     ```bash
     COHERE_API_KEY=your-cohere-api-key
     ```

2. **Enable Re-ranking** (default: enabled if API key is set):
   ```bash
   ENABLE_RERANKING=true
   ```

3. **Configure Candidate Count** (optional):
   ```bash
   # Retrieve more candidates for better re-ranking
   # This is handled in code, but can be adjusted
   ```

### How It Works

1. **User Query**: "Hva er reglene for oppsigelse?"
2. **Hybrid Search**: Retrieves top 50 candidates using FTS + Vector search with RRF
3. **Re-ranking**: Cohere Rerank re-orders the 50 candidates by semantic relevance
4. **Pagination**: Returns top 5-10 re-ranked results for the LLM
5. **LLM Context**: Receives the most relevant chunks first

## Performance Considerations

### Latency

- **Hybrid Search**: ~100-500ms (depends on dataset size)
- **Re-ranking**: ~200-800ms (depends on candidate count and Cohere API)
- **Total**: ~300-1300ms (acceptable for improved quality)

### Cost

- **Cohere Rerank**: ~$1 per 1,000 searches (varies by tier)
- **Cost per query**: ~$0.001 (very affordable)

### Optimization

- Re-ranking is only applied to first page of results
- Subsequent pages use original hybrid search ranking
- Can be disabled via `ENABLE_RERANKING=false` if needed

## Configuration Options

### Disable Re-ranking

```bash
# In .env file
ENABLE_RERANKING=false
```

Or pass `enableReranking: false` to `searchLovdataPublicData()`.

### Adjust Candidate Count

Modify `rerankTopN` parameter:
- **Lower (20-30)**: Faster, less comprehensive
- **Higher (50-100)**: Slower, more comprehensive
- **Default (50)**: Good balance

### Use Different Model

Cohere offers multiple models:
- `rerank-multilingual-v3.0` (default) - Supports 100+ languages including Norwegian
- `rerank-english-v3.0` - English only, slightly faster

Change in `RerankService` constructor:
```typescript
const rerankService = new RerankService({ 
  model: 'rerank-multilingual-v3.0' 
});
```

## Monitoring

### Check Re-ranking Usage

Look for logs:
```
searchLovdataPublicData: re-ranking completed
  originalCount: 50
  rerankedCount: 10
  pageSize: 5
```

### Monitor Errors

Re-ranking failures are logged but don't break search:
```
searchLovdataPublicData: re-ranking failed, using original results
```

## Troubleshooting

### Re-ranking Not Working

**Symptoms**: Search results not re-ranked

**Causes**:
1. `COHERE_API_KEY` not set
2. `ENABLE_RERANKING=false`
3. Cohere API error

**Solution**: Check logs and verify API key

### Slow Search

**Symptoms**: Search takes >2 seconds

**Causes**:
1. Too many candidates (rerankTopN too high)
2. Cohere API latency
3. Network issues

**Solution**: Reduce `rerankTopN` or disable re-ranking

### API Errors

**Symptoms**: Re-ranking errors in logs

**Causes**:
1. Invalid API key
2. Rate limits
3. API downtime

**Solution**: Check Cohere API status, verify API key, check rate limits

## Benefits

1. **Better Relevance**: Most relevant documents appear first
2. **Improved Answers**: LLM receives better context
3. **Semantic Understanding**: Understands query meaning, not just keywords
4. **Configurable**: Can be enabled/disabled as needed
5. **Cost-Effective**: Very affordable (~$0.001 per query)

## Future Improvements

1. **Caching**: Cache re-ranking results for common queries
2. **Adaptive Re-ranking**: Only re-rank when confidence is low
3. **Multiple Models**: A/B test different re-ranking models
4. **Local Re-ranking**: Use local cross-encoder model to avoid API calls
5. **Hybrid Re-ranking**: Combine multiple re-ranking signals

## References

- [Cohere Rerank Documentation](https://docs.cohere.com/docs/reranking)
- [Re-ranking for RAG](https://www.pinecone.io/learn/reranking/)

