/**
 * Chunk existing documents in Supabase.
 * 
 * This script:
 * 1. Finds all documents without chunks
 * 2. Creates chunks using DocumentChunker
 * 3. Generates embeddings for chunks
 * 4. Inserts chunks into document_chunks table
 * 
 * Usage:
 *   npm run chunk-documents
 *   npm run chunk-documents -- --limit 100
 *   npm run chunk-documents -- --dry-run
 */

// CRITICAL: Set NODE_ENV to development BEFORE any imports
process.env.NODE_ENV = 'development';

// Load environment variables
import 'dotenv/config';

// Force NODE_ENV to development after dotenv loads
process.env.NODE_ENV = 'development';

import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { DocumentChunker } from '../src/services/documentChunker.js';
import OpenAI from 'openai';

// Minimal embedding service for chunks
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
    const maxLength = 20000; // Conservative limit

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      const truncatedBatch = batch.map(text => {
        if (text.length > maxLength) {
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
          break;
        } catch (error: any) {
          if (error?.message?.includes('maximum context length') || error?.message?.includes('8192 tokens')) {
            retryCount++;
            if (retryCount > maxRetries) {
              throw error;
            }
            
            const newMaxLength = Math.floor(maxLength * Math.pow(0.8, retryCount));
            console.warn(`  ⚠ Token limit error, retrying with reduced length: ${newMaxLength} chars (attempt ${retryCount}/${maxRetries})`);
            
            for (let j = 0; j < truncatedBatch.length; j++) {
              const originalText = batch[j];
              if (originalText.length > newMaxLength) {
                truncatedBatch[j] = originalText.substring(0, newMaxLength - 3) + '...';
              }
            }
            continue;
          }
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

type ChunkOptions = {
  supabaseUrl: string;
  serviceRoleKey: string;
  openaiApiKey: string;
  limit?: number;
  batchSize: number;
  embeddingBatchSize: number;
  dryRun: boolean;
  archiveFilename?: string;
};

interface DocumentRow {
  id: number;
  archive_filename: string;
  member: string;
  title: string | null;
  document_date: string | null;
  content: string;
}

function parseArgs(): ChunkOptions {
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
    : 50;
  const embeddingBatchSize = args.includes('--embedding-batch-size')
    ? parseInt(args[args.indexOf('--embedding-batch-size') + 1], 10)
    : 100;
  const dryRun = args.includes('--dry-run');
  const archiveFilename = args.includes('--archive')
    ? args[args.indexOf('--archive') + 1]
    : undefined;

  if (args.includes('--help')) {
    console.log(`
Chunk existing documents.

Usage:
  npm run chunk-documents [options]

Options:
  --limit <number>              Maximum number of documents to process (default: all)
  --batch-size <number>          Number of documents to process per batch (default: 50)
  --embedding-batch-size <number>  Number of chunk embeddings to generate per API call (default: 100)
  --archive <filename>           Only process documents from a specific archive
  --dry-run                      Show what would be done without making changes
  --help                         Show this help message

Examples:
  npm run chunk-documents
  npm run chunk-documents -- --limit 100
  npm run chunk-documents -- --archive "gjeldende-lover.tar.bz2"
  npm run chunk-documents -- --dry-run
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
    archiveFilename
  };
}

async function countDocumentsWithoutChunks(
  supabase: ReturnType<typeof createClient>,
  archiveFilename?: string
): Promise<number> {
  // Get all document IDs that have chunks
  let chunksQuery = supabase
    .from('document_chunks')
    .select('document_id');
  
  if (archiveFilename) {
    chunksQuery = chunksQuery.eq('archive_filename', archiveFilename);
  }

  const { data: chunksData } = await chunksQuery;
  const chunkedDocIds = new Set((chunksData || []).map((r: any) => r.document_id));

  // Count all documents
  let docsQuery = supabase
    .from('lovdata_documents')
    .select('id', { count: 'exact', head: true });
  
  if (archiveFilename) {
    docsQuery = docsQuery.eq('archive_filename', archiveFilename);
  }

  const { count: totalDocs } = await docsQuery;

  // Count unique documents with chunks
  const uniqueChunkedDocs = chunkedDocIds.size;

  return (totalDocs ?? 0) - uniqueChunkedDocs;
}

async function fetchDocumentsWithoutChunks(
  supabase: ReturnType<typeof createClient>,
  batchSize: number,
  offset: number,
  archiveFilename?: string
): Promise<DocumentRow[]> {
  // Get all document IDs that have chunks (using distinct to avoid duplicates)
  let chunksQuery = supabase
    .from('document_chunks')
    .select('document_id');
  
  if (archiveFilename) {
    chunksQuery = chunksQuery.eq('archive_filename', archiveFilename);
  }

  const { data: chunksData, error: chunksError } = await chunksQuery;
  
  if (chunksError) {
    throw new Error(`Failed to fetch chunked documents: ${chunksError.message}`);
  }

  // Create set of document IDs that already have chunks
  const chunkedDocIds = new Set((chunksData || []).map((r: any) => r.document_id));

  // Fetch documents in batches and filter out those with chunks
  // We need to fetch more than batchSize to account for filtering
  const fetchSize = batchSize * 3; // Fetch 3x to account for filtering
  let fetched = 0;
  const result: DocumentRow[] = [];
  let currentOffset = offset;

  while (result.length < batchSize && fetched < fetchSize * 2) {
    let query = supabase
      .from('lovdata_documents')
      .select('id, archive_filename, member, title, document_date, content')
      .order('id', { ascending: true })
      .range(currentOffset, currentOffset + fetchSize - 1);

    if (archiveFilename) {
      query = query.eq('archive_filename', archiveFilename);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch documents: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break; // No more documents
    }

    // Filter out documents that already have chunks
    const filtered = ((data as DocumentRow[]) ?? []).filter(doc => !chunkedDocIds.has(doc.id));
    result.push(...filtered);
    
    fetched += data.length;
    currentOffset += fetchSize;

    // If we got fewer results than requested, we've reached the end
    if (data.length < fetchSize) {
      break;
    }
  }

  return result.slice(0, batchSize); // Return only the requested batch size
}

async function insertChunksBatch(
  supabase: ReturnType<typeof createClient>,
  chunks: Array<{
    document_id: number;
    chunk_index: number;
    content: string;
    content_length: number;
    start_char: number;
    end_char: number;
    archive_filename: string;
    member: string;
    document_title: string | null;
    document_date: string | null;
    section_title: string | null;
    section_number: string | null;
    embedding?: number[];
  }>,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY RUN] Would insert ${chunks.length} chunks`);
    return;
  }

  // Check which chunks already exist to avoid duplicates
  if (chunks.length === 0) {
    return;
  }

  const documentId = chunks[0].document_id;
  const { data: existingChunks } = await supabase
    .from('document_chunks')
    .select('chunk_index')
    .eq('document_id', documentId);

  const existingChunkIndices = new Set((existingChunks || []).map((c: any) => c.chunk_index));

  // Filter out chunks that already exist
  const chunksToInsert = chunks.filter(chunk => !existingChunkIndices.has(chunk.chunk_index));

  if (chunksToInsert.length === 0) {
    console.log(`  ⚠ Document ${documentId} already has all chunks, skipping`);
    return;
  }

  if (chunksToInsert.length < chunks.length) {
    console.log(`  ⚠ Document ${documentId}: ${chunks.length - chunksToInsert.length} chunks already exist, inserting ${chunksToInsert.length} new chunks`);
  }

  // Use upsert to handle any race conditions gracefully
  const { error: insertError } = await supabase
    .from('document_chunks')
    .upsert(chunksToInsert, {
      onConflict: 'document_id,chunk_index',
      ignoreDuplicates: false
    });

  if (insertError) {
    throw new Error(`Failed to insert chunks for document ${documentId}: ${insertError.message}`);
  }
}

async function main() {
  const options = parseArgs();
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('Chunk Documents Script');
  console.log('='.repeat(60));
  console.log(`Dry run: ${options.dryRun ? 'YES' : 'NO'}`);
  if (options.limit) {
    console.log(`Limit: ${options.limit} documents`);
  }
  if (options.archiveFilename) {
    console.log(`Archive filter: ${options.archiveFilename}`);
  }
  console.log(`Batch size: ${options.batchSize} documents`);
  console.log(`Embedding batch size: ${options.embeddingBatchSize} chunks per API call`);
  console.log('='.repeat(60));
  console.log();

  const supabase = createClient(options.supabaseUrl, options.serviceRoleKey);
  const chunker = new DocumentChunker({
    chunkSize: 12800,
    overlapSize: 2560,
    preserveParagraphs: true,
    extractSections: true
  });

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

  console.log('Counting documents without chunks...');
  const totalWithoutChunks = await countDocumentsWithoutChunks(supabase, options.archiveFilename);
  console.log(`Found ${totalWithoutChunks.toLocaleString()} documents without chunks`);
  console.log();

  if (totalWithoutChunks === 0) {
    console.log('✓ All documents already have chunks!');
    return;
  }

  const maxDocuments = options.limit ?? totalWithoutChunks;
  const documentsToProcess = Math.min(maxDocuments, totalWithoutChunks);
  console.log(`Will process ${documentsToProcess.toLocaleString()} documents`);
  console.log();

  let processed = 0;
  let totalChunksCreated = 0;
  let errors = 0;
  let offset = 0;

  while (processed < documentsToProcess) {
    const remaining = documentsToProcess - processed;
    const currentBatchSize = Math.min(options.batchSize, remaining);

    console.log(`[${new Date().toISOString()}] Fetching batch (offset: ${offset}, size: ${currentBatchSize})...`);

    let documents: DocumentRow[];
    try {
      documents = await fetchDocumentsWithoutChunks(
        supabase,
        currentBatchSize * 2, // Fetch more to account for filtering
        offset,
        options.archiveFilename
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

    // Process each document
    for (const doc of documents) {
      if (processed >= documentsToProcess) {
        break;
      }

      try {
        // Create chunks
        const chunks = chunker.chunkDocument(doc.content);
        console.log(`  Document ${doc.id}: Created ${chunks.length} chunks`);

        // Generate embeddings for chunks
        let chunkEmbeddings: number[][] = [];
        if (!options.dryRun && chunks.length > 0) {
          try {
            const chunkTexts = chunks.map(c => c.content);
            chunkEmbeddings = await embeddingService.generateEmbeddings(chunkTexts);
            
            if (chunkEmbeddings.length !== chunks.length) {
              console.warn(`  ⚠ Document ${doc.id}: Expected ${chunks.length} embeddings, got ${chunkEmbeddings.length}`);
              // Pad with empty arrays if needed
              while (chunkEmbeddings.length < chunks.length) {
                chunkEmbeddings.push([]);
              }
            }
          } catch (embeddingError) {
            const errorMsg = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
            // Log more details about the error
            if (errorMsg.includes('rate limit') || errorMsg.includes('429')) {
              console.warn(`  ⚠ Document ${doc.id}: Rate limit hit, skipping embeddings. Will retry on next run.`);
            } else if (errorMsg.includes('token') || errorMsg.includes('context length')) {
              console.warn(`  ⚠ Document ${doc.id}: Token limit exceeded, skipping embeddings for this document.`);
            } else {
              console.warn(`  ⚠ Document ${doc.id}: Failed to generate embeddings: ${errorMsg.substring(0, 150)}`);
            }
            // Continue without embeddings - chunks will be inserted without embeddings
            chunkEmbeddings = [];
          }
        }

        // Prepare chunk rows
        const chunkRows = chunks.map((chunk, idx) => ({
          document_id: doc.id,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          content_length: chunk.contentLength,
          start_char: chunk.startChar,
          end_char: chunk.endChar,
          archive_filename: doc.archive_filename,
          member: doc.member,
          document_title: doc.title,
          document_date: doc.document_date,
          section_title: chunk.metadata.sectionTitle ?? null,
          section_number: chunk.metadata.sectionNumber ?? null,
          // Only include embedding if we have one for this chunk index
          embedding: (chunkEmbeddings.length > idx && chunkEmbeddings[idx] && chunkEmbeddings[idx].length > 0) 
            ? chunkEmbeddings[idx] 
            : undefined
        }));

        // Insert chunks
        await insertChunksBatch(supabase, chunkRows, options.dryRun);
        totalChunksCreated += chunks.length;
        processed++;

        if (processed % 10 === 0) {
          const progress = ((processed / documentsToProcess) * 100).toFixed(1);
          console.log(`  Progress: ${processed}/${documentsToProcess} (${progress}%) - ${totalChunksCreated} chunks created`);
        }
      } catch (error) {
        console.error(`  ✗ Failed to process document ${doc.id}:`, error);
        errors++;
      }
    }

    offset += currentBatchSize;
  }

  // Summary
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Processed: ${processed.toLocaleString()} documents`);
  console.log(`Chunks created: ${totalChunksCreated.toLocaleString()}`);
  console.log(`Errors: ${errors.toLocaleString()}`);
  console.log(`Duration: ${totalDuration}s`);
  console.log('='.repeat(60));

  if (options.dryRun) {
    console.log();
    console.log('This was a dry run. No changes were made.');
  } else if (processed > 0) {
    console.log();
    console.log('✓ Chunking completed successfully!');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

