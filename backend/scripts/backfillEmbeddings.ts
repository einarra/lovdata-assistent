/**
 * Backfill embeddings for existing documents in Supabase.
 * 
 * This script:
 * 1. Finds all documents without embeddings
 * 2. Generates embeddings using OpenAI text-embedding-3-small
 * 3. Updates the database with embeddings in batches
 * 4. Provides progress tracking and error handling
 * 
 * Usage:
 *   npm run backfill-embeddings
 *   npm run backfill-embeddings -- --limit 1000
 *   npm run backfill-embeddings -- --dry-run
 *   npm run backfill-embeddings -- --archive "filename.tar.bz2"
 */

// CRITICAL: Set NODE_ENV to development BEFORE any imports
// This prevents production validation from running
process.env.NODE_ENV = 'development';

// Load environment variables
import 'dotenv/config';

// Force NODE_ENV to development after dotenv loads (in case .env overrides it)
process.env.NODE_ENV = 'development';

import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Create a minimal EmbeddingService that doesn't import env.ts
// This avoids production validation issues
class ScriptEmbeddingService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly batchSize: number;

  constructor(options: { batchSize?: number; openaiApiKey: string }) {
    if (!options.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    this.client = new OpenAI({
      apiKey: options.openaiApiKey,
      timeout: 30000,
    });

    this.model = 'text-embedding-3-small';
    this.batchSize = options.batchSize ?? 100;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];
    // text-embedding-3-small has max 8,191 tokens per input
    // Very conservative estimate: 1 token ≈ 3-4 characters for Norwegian text
    // Using 20,000 chars to be safe (≈5,000-6,666 tokens, well under 8,191 limit)
    const maxLength = 20000;

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      // Truncate texts with retry logic for token limit errors
      const truncatedBatch = batch.map(text => {
        if (text.length > maxLength) {
          // Truncate and add ellipsis to indicate truncation
          return text.substring(0, maxLength - 3) + '...';
        }
        return text;
      });

      let response;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount <= maxRetries) {
        try {
          response = await this.client.embeddings.create({
            model: this.model,
            input: truncatedBatch,
          });
          break; // Success, exit retry loop
        } catch (error: any) {
          // Check if it's a token limit error
          if (error?.message?.includes('maximum context length') || error?.message?.includes('8192 tokens')) {
            retryCount++;
            if (retryCount > maxRetries) {
              throw error; // Give up after max retries
            }
            
            // Reduce truncation length by 20% each retry
            const newMaxLength = Math.floor(maxLength * Math.pow(0.8, retryCount));
            console.warn(`  ⚠ Token limit error, retrying with reduced length: ${newMaxLength} chars (attempt ${retryCount}/${maxRetries})`);
            
            // Re-truncate with smaller limit
            for (let j = 0; j < truncatedBatch.length; j++) {
              const originalText = batch[j];
              if (originalText.length > newMaxLength) {
                truncatedBatch[j] = originalText.substring(0, newMaxLength - 3) + '...';
              }
            }
            continue; // Retry with smaller texts
          }
          
          // Not a token limit error, throw immediately
          throw error;
        }
      }

      if (!response || !response.data || response.data.length !== batch.length) {
        throw new Error(`Expected ${batch.length} embeddings, got ${response?.data?.length ?? 0}`);
      }

      results.push(...response.data.map(item => item.embedding));
    }

    return results;
  }
}

type BackfillOptions = {
  supabaseUrl: string;
  serviceRoleKey: string;
  openaiApiKey: string;
  limit?: number;
  batchSize: number;
  embeddingBatchSize: number;
  dryRun: boolean;
  archiveFilename?: string;
  resumeFromId?: number;
};

interface DocumentRow {
  id: number;
  archive_filename: string;
  member: string;
  content: string;
}

function parseArgs(): BackfillOptions {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const openaiApiKey = process.env.OPENAI_API_KEY ?? '';

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. Aborting.');
    process.exit(1);
  }

  if (!openaiApiKey) {
    console.error('Missing OPENAI_API_KEY in environment. Aborting.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const limit = args.includes('--limit') 
    ? parseInt(args[args.indexOf('--limit') + 1], 10) 
    : undefined;
  const batchSize = args.includes('--batch-size')
    ? parseInt(args[args.indexOf('--batch-size') + 1], 10)
    : 100;
  const embeddingBatchSize = args.includes('--embedding-batch-size')
    ? parseInt(args[args.indexOf('--embedding-batch-size') + 1], 10)
    : 100;
  const dryRun = args.includes('--dry-run');
  const archiveFilename = args.includes('--archive')
    ? args[args.indexOf('--archive') + 1]
    : undefined;
  const resumeFromId = args.includes('--resume-from-id')
    ? parseInt(args[args.indexOf('--resume-from-id') + 1], 10)
    : undefined;

  if (args.includes('--help')) {
    console.log(`
Backfill embeddings for existing documents.

Usage:
  npm run backfill-embeddings [options]

Options:
  --limit <number>              Maximum number of documents to process (default: all)
  --batch-size <number>         Number of documents to update per batch (default: 100)
  --embedding-batch-size <number>  Number of embeddings to generate per API call (default: 100)
  --archive <filename>          Only process documents from a specific archive
  --resume-from-id <id>         Resume from a specific document ID (useful for resuming after errors)
  --dry-run                     Show what would be done without making changes
  --help                        Show this help message

Examples:
  npm run backfill-embeddings
  npm run backfill-embeddings -- --limit 1000
  npm run backfill-embeddings -- --archive "gjeldende-lover.tar.bz2"
  npm run backfill-embeddings -- --resume-from-id 5000
  npm run backfill-embeddings -- --dry-run
`);
    process.exit(0);
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    openaiApiKey,
    limit,
    batchSize,
    embeddingBatchSize,
    dryRun,
    archiveFilename,
    resumeFromId
  };
}

async function countDocumentsWithoutEmbeddings(
  supabase: ReturnType<typeof createClient>,
  archiveFilename?: string
): Promise<number> {
  let query = supabase
    .from('lovdata_documents')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null);

  if (archiveFilename) {
    query = query.eq('archive_filename', archiveFilename);
  }

  const { count, error } = await query;

  if (error) {
    throw new Error(`Failed to count documents: ${error.message}`);
  }

  return count ?? 0;
}

async function fetchDocumentsBatch(
  supabase: ReturnType<typeof createClient>,
  batchSize: number,
  offset: number,
  archiveFilename?: string,
  resumeFromId?: number
): Promise<DocumentRow[]> {
  let query = supabase
    .from('lovdata_documents')
    .select('id, archive_filename, member, content')
    .is('embedding', null)
    .order('id', { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (archiveFilename) {
    query = query.eq('archive_filename', archiveFilename);
  }

  if (resumeFromId) {
    query = query.gte('id', resumeFromId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch documents: ${error.message}`);
  }

  return (data as DocumentRow[]) ?? [];
}

async function updateEmbeddingsBatch(
  supabase: ReturnType<typeof createClient>,
  updates: Array<{ id: number; embedding: number[] }>,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY RUN] Would update ${updates.length} documents with embeddings`);
    return;
  }

  // Update documents with controlled concurrency to avoid overwhelming the database
  const concurrency = 20; // Process 20 updates in parallel
  const errors: Array<{ id: number; error: string }> = [];

  for (let i = 0; i < updates.length; i += concurrency) {
    const batch = updates.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (update) => {
        const { error } = await supabase
          .from('lovdata_documents')
          .update({ embedding: update.embedding })
          .eq('id', update.id);

        if (error) {
          throw new Error(error.message);
        }
        return update.id;
      })
    );

    // Collect errors
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        errors.push({
          id: batch[idx].id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  // Throw if there were any errors
  if (errors.length > 0) {
    const errorMessages = errors
      .slice(0, 5)
      .map(({ id, error }) => `Document ${id}: ${error}`)
      .join('; ');
    const more = errors.length > 5 ? ` and ${errors.length - 5} more` : '';
    throw new Error(`Failed to update ${errors.length} documents: ${errorMessages}${more}`);
  }
}

async function main() {
  const options = parseArgs();
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('Backfill Embeddings Script');
  console.log('='.repeat(60));
  console.log(`Dry run: ${options.dryRun ? 'YES' : 'NO'}`);
  if (options.limit) {
    console.log(`Limit: ${options.limit} documents`);
  }
  if (options.archiveFilename) {
    console.log(`Archive filter: ${options.archiveFilename}`);
  }
  if (options.resumeFromId) {
    console.log(`Resuming from ID: ${options.resumeFromId}`);
  }
  console.log(`Batch size: ${options.batchSize} documents`);
  console.log(`Embedding batch size: ${options.embeddingBatchSize} embeddings per API call`);
  console.log('='.repeat(60));
  console.log();

  // Initialize Supabase client
  const supabase = createClient(options.supabaseUrl, options.serviceRoleKey);

  // Initialize embedding service (using script-specific version)
  let embeddingService: ScriptEmbeddingService;
  try {
    embeddingService = new ScriptEmbeddingService({ 
      batchSize: options.embeddingBatchSize,
      openaiApiKey: options.openaiApiKey
    });
    console.log('✓ Embedding service initialized');
  } catch (error) {
    console.error('✗ Failed to initialize embedding service:', error);
    process.exit(1);
  }

  // Count documents without embeddings
  console.log('Counting documents without embeddings...');
  const totalWithoutEmbeddings = await countDocumentsWithoutEmbeddings(
    supabase,
    options.archiveFilename
  );
  console.log(`Found ${totalWithoutEmbeddings.toLocaleString()} documents without embeddings`);
  console.log();

  if (totalWithoutEmbeddings === 0) {
    console.log('✓ All documents already have embeddings!');
    return;
  }

  const maxDocuments = options.limit ?? totalWithoutEmbeddings;
  const documentsToProcess = Math.min(maxDocuments, totalWithoutEmbeddings);
  console.log(`Will process ${documentsToProcess.toLocaleString()} documents`);
  console.log();

  // Process documents in batches
  let processed = 0;
  let errors = 0;
  let offset = 0;
  const errorLog: Array<{ id: number; error: string }> = [];

  while (processed < documentsToProcess) {
    const remaining = documentsToProcess - processed;
    const currentBatchSize = Math.min(options.batchSize, remaining);
    
    // Recalculate remaining at the end of the loop iteration for ETA calculation
    // (will be updated after processing)

    console.log(`[${new Date().toISOString()}] Fetching batch (offset: ${offset}, size: ${currentBatchSize})...`);

    // Fetch batch of documents
    let documents: DocumentRow[];
    try {
      documents = await fetchDocumentsBatch(
        supabase,
        currentBatchSize,
        offset,
        options.archiveFilename,
        options.resumeFromId && offset === 0 ? options.resumeFromId : undefined
      );
    } catch (error) {
      console.error(`✗ Failed to fetch documents:`, error);
      errors++;
      break;
    }

    if (documents.length === 0) {
      console.log('No more documents to process.');
      break;
    }

    console.log(`  Fetched ${documents.length} documents`);

    // Generate embeddings
    console.log(`  Generating embeddings...`);
    const embeddingStartTime = Date.now();
    let embeddings: number[][];
    try {
      const texts = documents.map(doc => doc.content);
      embeddings = await embeddingService.generateEmbeddings(texts);
      const embeddingDuration = ((Date.now() - embeddingStartTime) / 1000).toFixed(2);
      console.log(`  ✓ Generated ${embeddings.length} embeddings in ${embeddingDuration}s`);
    } catch (error) {
      console.error(`  ✗ Failed to generate embeddings:`, error);
      errors += documents.length;
      errorLog.push(...documents.map(doc => ({ id: doc.id, error: String(error) })));
      offset += documents.length;
      continue;
    }

    if (embeddings.length !== documents.length) {
      console.error(`  ✗ Mismatch: ${documents.length} documents but ${embeddings.length} embeddings`);
      errors += documents.length;
      offset += documents.length;
      continue;
    }

    // Update database
    console.log(`  Updating database...`);
    const updateStartTime = Date.now();
    try {
      const updates = documents.map((doc, idx) => ({
        id: doc.id,
        embedding: embeddings[idx]
      }));

      await updateEmbeddingsBatch(supabase, updates, options.dryRun);
      const updateDuration = ((Date.now() - updateStartTime) / 1000).toFixed(2);
      console.log(`  ✓ Updated ${updates.length} documents in ${updateDuration}s`);
    } catch (error) {
      console.error(`  ✗ Failed to update documents:`, error);
      errors += documents.length;
      errorLog.push(...documents.map(doc => ({ id: doc.id, error: String(error) })));
      offset += documents.length;
      continue;
    }

    processed += documents.length;
    offset += documents.length;

    const progress = ((processed / documentsToProcess) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (processed / ((Date.now() - startTime) / 1000)).toFixed(1);
    const remainingAfterProcessing = documentsToProcess - processed;
    const estimatedTimeRemaining = remainingAfterProcessing > 0 ? ((remainingAfterProcessing / parseFloat(rate)) / 60).toFixed(1) : '0';

    console.log(`  Progress: ${processed.toLocaleString()}/${documentsToProcess.toLocaleString()} (${progress}%)`);
    console.log(`  Rate: ${rate} docs/sec | Elapsed: ${elapsed}s | ETA: ${estimatedTimeRemaining}min`);
    console.log();

    // Small delay to avoid rate limiting
    if (processed < documentsToProcess) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Summary
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Processed: ${processed.toLocaleString()} documents`);
  console.log(`Errors: ${errors.toLocaleString()}`);
  console.log(`Duration: ${totalDuration}s`);
  if (processed > 0) {
    console.log(`Average rate: ${(processed / parseFloat(totalDuration)).toFixed(1)} docs/sec`);
  }

  if (errorLog.length > 0) {
    console.log();
    console.log(`Errors encountered (showing first 10):`);
    errorLog.slice(0, 10).forEach(({ id, error }) => {
      console.log(`  Document ${id}: ${error}`);
    });
    if (errorLog.length > 10) {
      console.log(`  ... and ${errorLog.length - 10} more errors`);
    }
  }

  if (errors > 0 && !options.dryRun) {
    console.log();
    console.log('⚠ Some documents failed to process. You can resume with:');
    if (errorLog.length > 0) {
      const lastFailedId = errorLog[errorLog.length - 1].id;
      console.log(`  npm run backfill-embeddings -- --resume-from-id ${lastFailedId}`);
    }
  }

  console.log('='.repeat(60));

  if (options.dryRun) {
    console.log();
    console.log('This was a dry run. No changes were made.');
    console.log('Run without --dry-run to actually update embeddings.');
  } else if (processed > 0) {
    console.log();
    console.log('✓ Backfill completed successfully!');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
