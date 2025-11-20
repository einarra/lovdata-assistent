# Database Query Optimization Recommendations

## Current State
- Query times out at 3 seconds consistently
- Using full-text search on `tsv_content` with GIN index (good!)
- Selecting `content` column which can be large
- Ordering by `id` instead of relevance
- Using `type: 'plain'` with manual tsquery construction

## Optimizations Applied

### 1. ✅ Changed textSearch type to 'websearch'
- **Before**: `type: 'plain'` with manual `token:* & token:*` construction
- **After**: `type: 'websearch'` with simple space-separated tokens
- **Benefit**: Faster query parsing, more forgiving, handles operators automatically
- **Trade-off**: May lose some prefix matching precision, but should be faster

### 2. ✅ Simplified tsquery construction
- **Before**: `tokens.map(token => \`${token}:*\`).join(' & ')`
- **After**: `tokens.join(' ')`
- **Benefit**: Simpler, faster to construct, works with 'websearch' type

## Additional Optimizations to Consider

### 3. Order by Relevance (ts_rank) - HIGH IMPACT
**Current**: Orders by `id` (arbitrary)
**Optimization**: Order by `ts_rank(tsv_content, to_tsquery(...)) DESC`

**Implementation**:
```typescript
// This requires using a Postgres function or raw SQL
// Option A: Create a Supabase RPC function
// Option B: Use raw SQL query (if Supabase client supports it)

// Example RPC function (create in Supabase):
CREATE OR REPLACE FUNCTION search_lovdata_documents(
  search_query text,
  result_limit int,
  result_offset int
)
RETURNS TABLE (
  archive_filename text,
  member text,
  title text,
  document_date text,
  content text,
  rank real
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    d.archive_filename,
    d.member,
    d.title,
    d.document_date,
    d.content,
    ts_rank(d.tsv_content, to_tsquery('norwegian', search_query)) as rank
  FROM lovdata_documents d
  WHERE d.tsv_content @@ to_tsquery('norwegian', search_query)
  ORDER BY rank DESC
  LIMIT result_limit
  OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;
```

**Benefit**: Results ordered by relevance, potentially faster with proper index usage

### 4. Reduce Content Size in Search Query - MEDIUM IMPACT
**Current**: Fetches full `content` for all results
**Optimization**: Fetch content separately only for results that need snippets

**Implementation**:
```typescript
// Step 1: Search without content
const { data: searchResults, count } = await this.supabase
  .from('lovdata_documents')
  .select('archive_filename, member, title, document_date', { count: 'exact' })
  .textSearch('tsv_content', tsQuery, { type: 'websearch', config: 'norwegian' })
  .order('id', { ascending: true })
  .range(offset, offset + limit - 1);

// Step 2: Fetch content only for results we need (in parallel)
const contentPromises = searchResults.map(doc => 
  this.getDocumentContentAsync(doc.archive_filename, doc.member)
);
const contents = await Promise.all(contentPromises);

// Step 3: Combine for snippets
const hits = searchResults.map((doc, i) => ({
  ...doc,
  snippet: this.generateSnippet(contents[i] || '', tokens, 150)
}));
```

**Benefit**: Smaller initial query, faster response, content fetched in parallel

### 5. Add Composite Index - MEDIUM IMPACT
**Current**: Only GIN index on `tsv_content`
**Optimization**: Add composite index for common query patterns

```sql
-- If you often filter by archive_filename
CREATE INDEX IF NOT EXISTS idx_lovdata_documents_archive_tsv
  ON lovdata_documents (archive_filename, tsv_content);

-- Or if you filter by date
CREATE INDEX IF NOT EXISTS idx_lovdata_documents_date_tsv
  ON lovdata_documents (document_date, tsv_content);
```

**Benefit**: Faster queries when combining full-text search with filters

### 6. Increase Query Timeout - LOW IMPACT (if query is actually fast)
**Current**: 3-second timeout (very aggressive)
**Optimization**: If query completes in <1s locally, increase timeout to 5-8s

**Note**: The 3s timeout might be too aggressive if the query is actually fast but network is slow

### 7. Use Connection Pooling - MEDIUM IMPACT
**Current**: Using Supabase client (should have pooling, but verify)
**Optimization**: Ensure Supabase connection pooling is configured correctly

**Check**: Verify in Supabase dashboard that connection pooling is enabled

### 8. Query Result Caching - LOW-MEDIUM IMPACT
**Optimization**: Cache common query results for a short time (e.g., 30 seconds)

**Implementation**: Add Redis or in-memory cache for frequent queries

## Recommended Priority Order

1. **Test current changes** (websearch type) - Already applied
2. **Order by ts_rank** - High impact, requires RPC function
3. **Reduce content in search query** - Medium impact, moderate complexity
4. **Add composite indexes** - Medium impact, low complexity
5. **Increase timeout** - Low impact, test first to see actual query time

## Testing Recommendations

1. Test query performance locally with EXPLAIN ANALYZE
2. Monitor query times in production logs
3. Compare 'websearch' vs 'plain' type performance
4. Test with and without content column in SELECT

## Expected Improvements

- **websearch type**: 10-30% faster query parsing
- **ts_rank ordering**: Better relevance, potentially 20-40% faster with proper index
- **Content separation**: 30-50% faster initial query (content is large)
- **Composite indexes**: 20-50% faster when filtering by archive/date

## Notes

- The GIN index on `tsv_content` is already optimal for full-text search
- The 3-second timeout might be masking actual query performance
- Consider monitoring actual query execution time vs timeout time

