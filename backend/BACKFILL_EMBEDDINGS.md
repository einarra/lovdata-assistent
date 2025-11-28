# Backfill Embeddings Guide

This guide explains how to backfill embeddings for existing documents in your Supabase database.

## Overview

The backfill script (`backend/scripts/backfillEmbeddings.ts`) generates embeddings for documents that were inserted before the hybrid search feature was implemented. It:

1. Finds all documents without embeddings
2. Generates embeddings using OpenAI's `text-embedding-3-small` model
3. Updates the database with embeddings in batches
4. Provides progress tracking and error handling

## Prerequisites

1. **Database Migration Applied**: The `add_vector_search.sql` migration must be applied first
   ```sql
   -- Run this in Supabase SQL Editor
   -- See: backend/supabase/migrations/add_vector_search.sql
   ```

2. **Environment Variables**: Ensure these are set in your `.env` file:
   ```bash
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   OPENAI_API_KEY=your_openai_api_key
   ```

3. **OpenAI API Key**: You need a valid OpenAI API key with access to the embeddings API

## Usage

### Basic Usage

Backfill all documents without embeddings:

```bash
npm run backfill-embeddings
```

### Options

```bash
# Limit the number of documents to process
npm run backfill-embeddings -- --limit 1000

# Process only documents from a specific archive
npm run backfill-embeddings -- --archive "gjeldende-lover.tar.bz2"

# Resume from a specific document ID (useful after errors)
npm run backfill-embeddings -- --resume-from-id 5000

# Adjust batch sizes
npm run backfill-embeddings -- --batch-size 50 --embedding-batch-size 50

# Dry run (see what would be done without making changes)
npm run backfill-embeddings -- --dry-run

# Show help
npm run backfill-embeddings -- --help
```

### Options Explained

- `--limit <number>`: Maximum number of documents to process (default: all)
- `--batch-size <number>`: Number of documents to update per batch (default: 100)
- `--embedding-batch-size <number>`: Number of embeddings to generate per OpenAI API call (default: 100, max: 2048)
- `--archive <filename>`: Only process documents from a specific archive
- `--resume-from-id <id>`: Resume from a specific document ID (useful for resuming after errors)
- `--dry-run`: Show what would be done without making changes

## Performance Considerations

### Processing Speed

- **Typical rate**: 10-30 documents/second (depends on OpenAI API response time)
- **For 41,934 documents**: Approximately 30-70 minutes
- **Cost**: ~$0.02 per 1M tokens (text-embedding-3-small)

### Batch Sizes

- **Smaller batches** (e.g., 50): More reliable, slower, better for unstable connections
- **Larger batches** (e.g., 200): Faster, but more risk if errors occur
- **Default (100)**: Good balance between speed and reliability

### OpenAI Rate Limits

The script respects OpenAI's rate limits:
- **Requests per minute**: Varies by tier
- **Tokens per minute**: Varies by tier
- The script includes small delays between batches to avoid rate limiting

If you hit rate limits:
1. Reduce `--embedding-batch-size` (e.g., to 50)
2. Reduce `--batch-size` (e.g., to 50)
3. Wait and resume with `--resume-from-id`

## Monitoring Progress

The script provides real-time progress information:

```
[2025-01-12T10:30:00.000Z] Fetching batch (offset: 0, size: 100)...
  Fetched 100 documents
  Generating embeddings...
  ✓ Generated 100 embeddings in 2.34s
  Updating database...
  ✓ Updated 100 documents in 1.23s
  Progress: 100/41,934 (0.2%)
  Rate: 28.1 docs/sec | Elapsed: 3.6s | ETA: 24.8min
```

## Error Handling

### Automatic Error Recovery

The script continues processing even if individual batches fail:
- Errors are logged with document IDs
- Failed documents are skipped
- You can resume from the last failed ID

### Resuming After Errors

If the script fails or is interrupted:

1. **Find the last processed ID**: Check the script output for the last successful batch
2. **Resume from that ID**:
   ```bash
   npm run backfill-embeddings -- --resume-from-id <last_id>
   ```

### Common Errors

**OpenAI API Errors**:
- **Rate limit exceeded**: Reduce batch sizes and wait
- **Invalid API key**: Check your `OPENAI_API_KEY` environment variable
- **Insufficient credits**: Add credits to your OpenAI account

**Database Errors**:
- **Connection timeout**: Check your Supabase connection
- **Permission denied**: Verify `SUPABASE_SERVICE_ROLE_KEY` has write access
- **Column not found**: Ensure the migration was applied

## Cost Estimation

### For 41,934 documents:

- **Average document size**: ~5,000 characters (~1,250 tokens)
- **Total tokens**: ~52M tokens
- **Cost**: ~$1.04 (at $0.02 per 1M tokens)

### Reducing Costs

- Process in smaller batches during off-peak hours
- Use `--limit` to process documents incrementally
- Monitor OpenAI usage dashboard

## Verification

After backfilling, verify embeddings were created:

```sql
-- Check embedding coverage
SELECT 
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) * 100.0 / COUNT(*) as coverage_percent,
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) as with_embeddings,
  COUNT(*) FILTER (WHERE embedding IS NULL) as without_embeddings
FROM lovdata_documents;
```

Expected result: `coverage_percent` should be 100% (or close to it).

## Best Practices

1. **Start with a dry run**: Always test with `--dry-run` first
2. **Process incrementally**: Use `--limit` to process in smaller chunks
3. **Monitor costs**: Check OpenAI usage dashboard regularly
4. **Resume capability**: Use `--resume-from-id` if the script is interrupted
5. **Archive-specific**: Use `--archive` to process one archive at a time
6. **Off-peak hours**: Run during low-traffic periods to avoid impacting users

## Troubleshooting

### Script hangs or is very slow

- Check OpenAI API status
- Verify network connection
- Reduce batch sizes
- Check Supabase connection

### Some documents still missing embeddings

- Check error log in script output
- Verify those documents have non-empty content
- Re-run with `--resume-from-id` for failed documents

### Out of memory errors

- Reduce `--batch-size` and `--embedding-batch-size`
- Process archives separately using `--archive`

## Example Workflow

```bash
# 1. Dry run to see what will be processed
npm run backfill-embeddings -- --dry-run

# 2. Process first 1000 documents as a test
npm run backfill-embeddings -- --limit 1000

# 3. Verify embeddings were created
# (Run SQL query above)

# 4. Process remaining documents
npm run backfill-embeddings -- --limit 10000

# 5. Continue until all are processed
npm run backfill-embeddings
```

## Support

If you encounter issues:

1. Check the error messages in the script output
2. Verify environment variables are set correctly
3. Ensure the database migration was applied
4. Check OpenAI API status and credits
5. Review the logs for specific error details

