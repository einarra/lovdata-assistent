#!/usr/bin/env tsx
import 'dotenv/config';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { logger } from '../logger.js';
import { EmbeddingService } from '../services/embeddingService.js';

/**
 * Estimate token count from character count.
 * For Norwegian text: ~3-4 characters per token
 * Using conservative estimate of 3 chars/token
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Truncate text intelligently for embedding generation.
 * OpenAI embeddings API has a limit of 8,191 tokens.
 * We use a conservative limit of ~6,000 tokens (18,000 chars) to leave buffer.
 * For very large chunks, we take the beginning and a summary from the end.
 */
function prepareTextForEmbedding(text: string): { text: string; wasTruncated: boolean; originalLength: number } {
  const maxChars = 18000; // ~6,000 tokens (conservative, under 8,191 limit)
  
  if (text.length <= maxChars) {
    return { text, wasTruncated: false, originalLength: text.length };
  }

  // For large chunks, take beginning (most important) and end (context)
  // Split: 90% beginning, 10% end
  const beginningChars = Math.floor(maxChars * 0.9);
  const endChars = maxChars - beginningChars;
  
  const beginning = text.substring(0, beginningChars);
  const end = text.substring(text.length - endChars);
  
  return {
    text: `${beginning}\n\n[... content truncated for embedding ...]\n\n${end}`,
    wasTruncated: true,
    originalLength: text.length
  };
}

async function main() {
  const supabase = getSupabaseAdminClient();
  logger.info('Starting backfill of chunk embeddings...');

  // First, check if embedding service is available
  let embeddingService: EmbeddingService | null = null;
  try {
    embeddingService = new EmbeddingService({ logger });
    logger.info('Embedding service initialized');
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize embedding service - cannot backfill embeddings');
    return;
  }

  // Get count of chunks that need updating
  const { count: totalChunks, error: countError } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null);

  if (countError) {
    logger.error({ err: countError }, 'Failed to count chunks');
    return;
  }

  logger.info({ totalChunks: totalChunks ?? 0 }, 'Chunks to process');

  if (!totalChunks || totalChunks === 0) {
    logger.info('No chunks to update');
    return;
  }

  // Reduced batch size for better error handling and memory management
  const batchSize = 50; // Process 50 chunks at a time (reduced from 100)
  let processed = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0; // Chunks skipped due to size/errors
  const stats = {
    chunksTruncated: 0,
    largeChunks: 0, // > 100k chars
    veryLargeChunks: 0, // > 500k chars
    emptyChunks: 0
  };

  // Process chunks in batches
  for (let offset = 0; offset < totalChunks; offset += batchSize) {
    logger.info({
      offset,
      batchSize,
      total: totalChunks,
      progress: `${((offset / totalChunks) * 100).toFixed(1)}%`
    }, 'Processing batch');

    // Fetch batch of chunks with null embedding
    const { data: chunks, error: fetchError } = await supabase
      .from('document_chunks')
      .select('id, content, content_length')
      .is('embedding', null)
      .order('id', { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (fetchError) {
      logger.error({ err: fetchError, offset }, 'Failed to fetch chunks batch');
      failed += batchSize;
      continue;
    }

    if (!chunks || chunks.length === 0) {
      break; // No more chunks to process
    }

    // Process chunks individually for better error isolation and handling of large chunks
    for (const chunk of chunks) {
      try {
        processed++;

        // Skip empty chunks
        if (!chunk.content || chunk.content.trim().length === 0) {
          logger.debug({ chunkId: chunk.id }, 'Skipping empty chunk');
          stats.emptyChunks++;
          skipped++;
          continue;
        }

        // Track large chunks
        const contentLength = chunk.content.length;
        const estimatedTokens = estimateTokenCount(chunk.content);
        
        if (contentLength > 500000) {
          stats.veryLargeChunks++;
          logger.warn({
            chunkId: chunk.id,
            contentLength,
            estimatedTokens
          }, 'Processing very large chunk (>500k chars)');
        } else if (contentLength > 100000) {
          stats.largeChunks++;
          logger.debug({
            chunkId: chunk.id,
            contentLength,
            estimatedTokens
          }, 'Processing large chunk (>100k chars)');
        }

        // Prepare text for embedding (handles truncation if needed)
        const prepared = prepareTextForEmbedding(chunk.content);
        
        if (prepared.wasTruncated) {
          stats.chunksTruncated++;
          logger.debug({
            chunkId: chunk.id,
            originalLength: prepared.originalLength,
            truncatedLength: prepared.text.length,
            originalTokens: estimateTokenCount(chunk.content),
            truncatedTokens: estimateTokenCount(prepared.text)
          }, 'Truncated chunk for embedding');
        }

        // Generate embedding for this chunk
        const embedding = await embeddingService.generateEmbedding(prepared.text);

        // Update chunk with embedding
        const { error: updateError } = await supabase
          .from('document_chunks')
          .update({ embedding })
          .eq('id', chunk.id);

        if (updateError) {
          logger.error({ err: updateError, chunkId: chunk.id }, 'Failed to update chunk embedding');
          failed++;
        } else {
          updated++;
        }

        // Small delay between individual chunks to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay per chunk

      } catch (chunkError) {
        logger.error({
          err: chunkError,
          chunkId: chunk.id,
          contentLength: chunk.content?.length ?? 0
        }, 'Error processing individual chunk - skipping');
        failed++;
        skipped++;
      }
    }

    logger.info({
      processed,
      updated,
      failed,
      skipped,
      remaining: totalChunks - processed,
      stats
    }, 'Progress update');

    // Longer delay between batches to avoid rate limiting
    if (offset + batchSize < totalChunks) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between batches
    }
  }

  logger.info({
    totalProcessed: processed,
    totalUpdated: updated,
    totalFailed: failed,
    totalSkipped: skipped,
    stats
  }, 'Backfill completed');
}

main().catch(console.error);

