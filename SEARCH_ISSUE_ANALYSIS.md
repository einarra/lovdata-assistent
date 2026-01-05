# Search Issue Analysis: "ekteskapsloven" not finding documents

## Problem
Agent search for "ekteskapsloven" returns no results.

## Root Cause Analysis

### Issue 1: FTS Query Construction in RPC Function
The `search_document_chunks_hybrid` RPC function uses:
```sql
tokens := string_to_array(lower(trim(search_query)), ' ');
fts_query := array_to_string(
  array(
    select token || ':*'
    from unnest(tokens) as token
    where length(token) > 0
  ),
  ' & '
);
```

For "ekteskapsloven", this creates: `'ekteskapsloven:*'`

**Problem**: If `to_tsquery('norwegian', 'ekteskapsloven:*')` fails or the tsquery syntax is invalid, the entire FTS query fails silently or errors out.

### Issue 2: No Error Handling for Invalid tsquery
Line 131 in the RPC function:
```sql
where (fts_query = '' or c.tsv_content @@ to_tsquery('norwegian', fts_query))
```

If `to_tsquery` throws an error (e.g., invalid syntax), the entire query fails.

### Issue 3: Empty FTS Query Returns All Chunks
When `fts_query = ''`, the condition `(fts_query = '' or ...)` returns ALL chunks (with filters). This is inefficient and might mask issues.

### Issue 4: Vector Search Might Not Have Embeddings
If chunks don't have embeddings, vector search returns nothing, and if FTS also fails, we get zero results.

## Solutions

1. **Add error handling for tsquery construction** - Use `plainto_tsquery` or handle errors gracefully
2. **Improve token extraction** - Handle compound words better
3. **Add fallback logic** - If FTS fails, still try vector search
4. **Add logging** - Log the actual FTS query being used

