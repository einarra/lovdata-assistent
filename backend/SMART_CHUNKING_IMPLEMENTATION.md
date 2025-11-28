# Smart Chunking Implementation

This document describes the implementation of smart chunking for legal documents to enable granular retrieval in the RAG system.

## Overview

Smart chunking splits long legal documents into smaller, focused chunks (12,800 characters) with overlap to preserve context. This enables the RAG system to retrieve specific paragraphs or sections that answer questions, rather than entire documents.

## Why Smart Chunking?

**Problem**: Legal documents are long (often 10,000+ characters). When searching, you want to retrieve the specific paragraph that answers the question, not the whole chapter.

**Solution**: Smart chunking provides:
- **Granular Retrieval**: Find specific sections/paragraphs
- **Better Relevance**: Smaller chunks = more focused search results
- **Context Preservation**: Overlap ensures no information is lost at boundaries
- **Metadata Preservation**: Section titles and numbers are preserved for citations

## Implementation Details

### 1. Database Schema

**Migration**: `backend/supabase/migrations/add_document_chunks.sql`

The `document_chunks` table stores:
- Chunk content and position (start_char, end_char)
- Parent document reference (document_id)
- Preserved metadata (document_title, document_date, section_title, section_number)
- Full-text search vector (tsv_content)
- Embedding vector for semantic search
- Chunk index (order within document)

**Indexes**:
- HNSW index on embeddings for fast vector search
- GIN index on tsv_content for fast full-text search
- Composite indexes for common query patterns

### 2. Chunking Service

**File**: `backend/src/services/documentChunker.ts`

**Features**:
- **Configurable chunk size**: Default 12,800 characters
- **Overlap**: Default 20% (2,560 characters) between chunks
- **Paragraph preservation**: Tries to split at paragraph boundaries
- **Section extraction**: Extracts section titles and numbers from content
- **Metadata preservation**: Maintains document structure information

**Chunking Algorithm**:
1. Split document into chunks of target size
2. Try to split at paragraph boundaries (double newlines)
3. Add overlap between chunks to preserve context
4. Extract section metadata from each chunk
5. Preserve document-level metadata (title, date)

### 3. Document Ingestion

**Updated**: `backend/src/storage/supabaseArchiveStore.ts`

When documents are ingested:
1. Documents are inserted into `lovdata_documents` table
2. Documents are chunked using `DocumentChunker`
3. Embeddings are generated for each chunk
4. Chunks are inserted into `document_chunks` table with:
   - Chunk content and metadata
   - Embeddings for semantic search
   - Full-text search vector

### 4. Search Implementation

**Updated**: `backend/src/storage/supabaseArchiveStore.ts::searchAsync()`

Search now uses `search_document_chunks_hybrid()` function which:
- Searches chunks instead of full documents
- Uses hybrid search (FTS + Vector) with RRF
- Returns chunk-level results with preserved metadata
- Displays section information in search results

**Result Format**:
- Chunk content (focused snippet)
- Document title + section number (if available)
- Section title (if extracted)
- Document date

### 5. Chunking Existing Documents

**Script**: `backend/scripts/chunkDocuments.ts`

For documents that were ingested before chunking was implemented:
- Finds documents without chunks
- Creates chunks using DocumentChunker
- Generates embeddings for chunks
- Inserts chunks into database

## Usage

### Apply Database Migration

```sql
-- Run in Supabase SQL Editor
-- See: backend/supabase/migrations/add_document_chunks.sql
```

### Chunk Existing Documents

```bash
# Chunk all documents without chunks
npm run chunk-documents

# Chunk with limit
npm run chunk-documents -- --limit 100

# Chunk specific archive
npm run chunk-documents -- --archive "gjeldende-lover.tar.bz2"

# Dry run
npm run chunk-documents -- --dry-run
```

### New Documents

New documents are automatically chunked during ingestion. No additional steps needed.

## Configuration

### Chunk Size

Default: 12,800 characters
- Large enough to contain complete paragraphs/sections
- Small enough for focused retrieval
- Well under token limits for embeddings

### Overlap Size

Default: 2,560 characters (20% of chunk size)
- Ensures context isn't lost at boundaries
- Helps with questions that span chunk boundaries

### Paragraph Preservation

Enabled by default
- Tries to split at paragraph boundaries (double newlines)
- Falls back to single newlines if needed
- Prevents splitting in the middle of sentences

## Benefits

1. **Better Search Results**: Returns specific paragraphs instead of entire documents
2. **Improved Citations**: Section numbers and titles are preserved
3. **Faster Retrieval**: Smaller chunks = faster vector similarity search
4. **Context Preservation**: Overlap ensures no information loss
5. **Metadata Rich**: Section information helps with citations

## Performance Considerations

### Storage

- Each document creates ~1-5 chunks (depending on size)
- For 41,934 documents: ~100,000-200,000 chunks expected
- Each chunk has embedding (1536 dimensions) = ~6MB per 1000 chunks

### Search Performance

- Chunk search is faster than document search (smaller vectors)
- More results to rank (chunks vs documents)
- RRF combines rankings efficiently

### Embedding Generation

- More embeddings needed (chunks vs documents)
- But chunks are smaller, so faster to generate
- Batch processing handles this efficiently

## Monitoring

### Check Chunk Coverage

```sql
-- Percentage of documents with chunks
SELECT 
  COUNT(DISTINCT d.id) FILTER (WHERE c.id IS NOT NULL) * 100.0 / COUNT(DISTINCT d.id) as coverage_percent,
  COUNT(DISTINCT d.id) FILTER (WHERE c.id IS NOT NULL) as documents_with_chunks,
  COUNT(DISTINCT d.id) FILTER (WHERE c.id IS NULL) as documents_without_chunks,
  COUNT(c.id) as total_chunks
FROM lovdata_documents d
LEFT JOIN document_chunks c ON d.id = c.document_id;
```

### Average Chunks Per Document

```sql
SELECT 
  AVG(chunk_count) as avg_chunks_per_doc,
  MIN(chunk_count) as min_chunks,
  MAX(chunk_count) as max_chunks
FROM (
  SELECT document_id, COUNT(*) as chunk_count
  FROM document_chunks
  GROUP BY document_id
) chunk_counts;
```

## Troubleshooting

### Documents Not Chunked

**Symptoms**: Search returns full documents instead of chunks

**Solution**: Run chunking script:
```bash
npm run chunk-documents
```

### Chunks Missing Embeddings

**Symptoms**: Vector search not working for chunks

**Solution**: Check if embeddings were generated during chunking. Re-run chunking if needed.

### Search Still Using Documents

**Check**: Verify `search_document_chunks_hybrid` function exists in database. If not, run the migration.

## Future Improvements

1. **Adaptive Chunking**: Adjust chunk size based on document structure
2. **Hierarchical Chunks**: Support nested chunks (document → chapter → section → paragraph)
3. **Chunk Quality Scoring**: Rank chunks by relevance before embedding
4. **Smart Overlap**: Vary overlap based on content type
5. **Section Detection**: Better extraction of legal document structure

## References

- [Supabase pgvector Documentation](https://supabase.com/docs/guides/database/extensions/pgvector)
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Chunking Strategies for RAG](https://www.pinecone.io/learn/chunking-strategies/)

