import path from 'node:path';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { EmbeddingService } from '../services/embeddingService.js';
import { DocumentChunker, type DocumentChunk } from '../services/documentChunker.js';
import type {
  ArchiveDocument,
  ArchiveIngestSession,
  ArchiveSearchHit,
  ArchiveSearchResult,
  ArchiveDocumentRecord
} from './types.js';
import { extractQueryTokens } from './types.js';
import { Timer } from '../utils/timing.js';

export class SupabaseArchiveStore {
  private readonly supabase = getSupabaseAdminClient();
  private readonly logs: Logger;
  private readonly embeddingService: EmbeddingService | null;
  private readonly chunker: DocumentChunker;
  private initialized = false;

  constructor(options?: { logger?: Logger; enableEmbeddings?: boolean; enableChunking?: boolean }) {
    this.logs = options?.logger ?? defaultLogger;
    
    // Initialize embedding service if embeddings are enabled
    // Check if OpenAI API key is available
    try {
      this.embeddingService = options?.enableEmbeddings !== false 
        ? new EmbeddingService({ logger: this.logs })
        : null;
      if (this.embeddingService) {
        this.logs.info('Embedding service initialized for vector search');
      }
    } catch (error) {
      this.logs.warn({ err: error }, 'Embedding service not available - vector search will be disabled');
      this.embeddingService = null;
    }

    // Initialize chunker (always enabled for better retrieval)
    this.chunker = new DocumentChunker({
      chunkSize: 12800,
      overlapSize: 2560, // 20% overlap
      preserveParagraphs: true,
      extractSections: true
    });
    if (options?.enableChunking !== false) {
      this.logs.info('Document chunker initialized');
    }
  }

  /**
   * Validates and sanitizes filename to prevent path traversal attacks.
   * @param filename - Archive filename to validate
   * @throws Error if filename is invalid
   */
  private validateFilename(filename: string): void {
    if (!filename || typeof filename !== 'string' || filename.length === 0) {
      throw new Error('Filename must be a non-empty string');
    }
    if (filename.length > 255) {
      throw new Error('Filename too long (max 255 characters)');
    }
    // Check for path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('Filename contains invalid characters');
    }
  }

  /**
   * Validates and sanitizes member path to prevent path traversal attacks.
   * @param member - Document member path to validate
   * @throws Error if member is invalid
   */
  private validateMember(member: string): void {
    if (!member || typeof member !== 'string' || member.length === 0) {
      throw new Error('Member must be a non-empty string');
    }
    if (member.length > 1000) {
      throw new Error('Member path too long (max 1000 characters)');
    }
  }

  /**
   * Sanitizes a storage path segment to prevent path traversal attacks.
   * @param segment - Path segment to sanitize
   * @returns Sanitized path segment
   */
  private sanitizeStoragePath(segment: string): string {
    // Remove path traversal attempts
    const normalized = path.normalize(segment).replace(/^(\.\.(\/|\\|$))+/, '');
    // Remove leading slashes and ensure no absolute paths
    const cleaned = normalized.replace(/^[\/\\]+/, '').replace(/[\/\\]+/g, '/');
    // Remove any remaining dangerous characters (control chars, special filesystem chars)
    // eslint-disable-next-line no-control-regex
    return cleaned.replace(/[<>:"|?*]/g, '').replace(/[\u0000-\u001f]/g, '');
  }

  async init(): Promise<void> {
    // Verify connection by checking if tables exist
    const { error } = await this.supabase.from('lovdata_archives').select('filename').limit(1);
    if (error) {
      throw new Error(`Failed to initialize Supabase ArchiveStore: ${error.message}`);
    }
    this.initialized = true;
    this.logs.info('Supabase ArchiveStore initialized');
  }

  close(): void {
    // No-op for Supabase (connection is managed by singleton)
    this.initialized = false;
  }

  isArchiveProcessed(_filename: string): boolean {
    // This is synchronous in SQLite, but we need async for Supabase
    // For compatibility, we'll make it async-aware but return false if not initialized
    if (!this.initialized) {
      return false;
    }
    // We'll need to make this async in practice, but keeping signature for compatibility
    // Callers should use async version or check after init
    return false; // Will be checked properly in async contexts
  }

  async isArchiveProcessedAsync(filename: string): Promise<boolean> {
    this.validateFilename(filename);

    const { data, error } = await this.supabase
      .from('lovdata_archives')
      .select('filename')
      .eq('filename', filename)
      .maybeSingle();

    if (error) {
      this.logs.warn({ err: error, filename }, 'Error checking archive status');
      return false;
    }

    return data !== null;
  }

  replaceDocuments(filename: string, documents: ArchiveDocument[]): void {
    // This is synchronous in SQLite but needs to be async for Supabase
    // For compatibility, we'll queue the operation
    this.replaceDocumentsAsync(filename, documents).catch(error => {
      this.logs.error({ err: error, filename }, 'Failed to replace documents');
    });
  }

  async replaceDocumentsAsync(filename: string, documents: ArchiveDocument[]): Promise<void> {
    const replaceTimer = new Timer('replace_documents', this.logs, { filename, documentCount: documents.length });
    this.validateFilename(filename);

    // Validate all document members
    for (const doc of documents) {
      this.validateMember(doc.member);
      if (doc.archiveFilename !== filename) {
        throw new Error(`Document archive filename mismatch: expected ${filename}, got ${doc.archiveFilename}`);
      }
    }

    // Use a transaction-like approach: perform all operations, but if any fails, we can't rollback
    // For true transaction safety, we'd need a Supabase RPC function, but this is safer than before
    try {
      // Step 1: Upsert archive record first (this is idempotent)
      const upsertTimer = new Timer('upsert_archive', this.logs, { filename });
      const { error: archiveError } = await this.supabase
        .from('lovdata_archives')
        .upsert(
          {
            filename,
            document_count: documents.length,
            processed_at: new Date().toISOString()
          },
          { onConflict: 'filename' }
        );
      upsertTimer.end();

      if (archiveError) {
        throw new Error(`Failed to upsert archive: ${archiveError.message}`);
      }

      // Step 2: Delete existing documents for this archive
      const deleteTimer = new Timer('delete_existing_documents', this.logs, { filename });
      const { error: deleteError } = await this.supabase
        .from('lovdata_documents')
        .delete()
        .eq('archive_filename', filename);
      deleteTimer.end();

      if (deleteError) {
        throw new Error(`Failed to delete existing documents: ${deleteError.message}`);
      }

      // Step 3: Generate embeddings if embedding service is available
      let embeddings: number[][] | null = null;
      if (this.embeddingService) {
        const embeddingTimer = new Timer('generate_embeddings', this.logs, { 
          filename, 
          documentCount: documents.length 
        });
        
        try {
          // Generate embeddings for all documents
          // Use content for embedding (title + content would be better, but content is most important)
          const texts = documents.map(doc => doc.content);
          embeddings = await this.embeddingService.generateEmbeddings(texts);
          embeddingTimer.end({ embeddingCount: embeddings.length });
          this.logs.info({ 
            filename, 
            embeddingCount: embeddings.length 
          }, 'Generated embeddings for documents');
        } catch (embeddingError) {
          // Log error but don't fail the entire ingestion
          // Documents will be inserted without embeddings
          this.logs.error({ 
            err: embeddingError, 
            filename 
          }, 'Failed to generate embeddings - documents will be inserted without embeddings');
          embeddings = null;
        }
      }

      // Step 4: Insert documents in batches with embeddings
      const batchSize = 500;
      const batchCount = Math.ceil(documents.length / batchSize);
      const documentIds: Map<string, number> = new Map(); // Map (archive_filename, member) -> document_id
      
      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        const batchTimer = new Timer('insert_documents_batch', this.logs, {
          filename,
          batchIndex: Math.floor(i / batchSize) + 1,
          batchCount,
          batchSize: batch.length,
          hasEmbeddings: embeddings !== null
        });
        
        const rows = batch.map((doc, idx) => {
          const row: any = {
            archive_filename: doc.archiveFilename,
            member: doc.member,
            title: doc.title,
            document_date: doc.date,
            content: doc.content,
            relative_path: doc.relativePath
          };
          
          // Add embedding if available
          // Supabase pgvector expects arrays directly, not strings
          if (embeddings && embeddings[i + idx]) {
            row.embedding = embeddings[i + idx];
          }
          
          return row;
        });

        const { data: insertedDocs, error: insertError } = await this.supabase
          .from('lovdata_documents')
          .insert(rows)
          .select('id, archive_filename, member');

        batchTimer.end();

        if (insertError) {
          // If batch insert fails, we've already deleted the old documents
          // This is a partial failure - log it and rethrow
          this.logs.error(
            { err: insertError, archive: filename, batchStart: i, batchSize: batch.length },
            'Failed to insert documents batch - database may be in inconsistent state'
          );
          throw new Error(`Failed to insert documents batch ${i}-${i + batch.length}: ${insertError.message}`);
        }

        // Store document IDs for chunk creation
        if (insertedDocs) {
          for (const doc of insertedDocs) {
            const key = `${doc.archive_filename}:${doc.member}`;
            documentIds.set(key, doc.id);
          }
        }
      }

      // Step 5: Create and insert chunks for all documents
      const chunkTimer = new Timer('create_and_insert_chunks', this.logs, { 
        filename, 
        documentCount: documents.length 
      });
      
      let totalChunks = 0;
      const chunkBatchSize = 200; // Insert chunks in batches
      
      for (let i = 0; i < documents.length; i += 50) { // Process documents in smaller batches for chunking
        const docBatch = documents.slice(i, i + 50);
        const allChunks: Array<{
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
        }> = [];

        // Create chunks for each document
        for (const doc of docBatch) {
          const key = `${doc.archiveFilename}:${doc.member}`;
          const documentId = documentIds.get(key);
          
          if (!documentId) {
            this.logs.warn({ archive: doc.archiveFilename, member: doc.member }, 'Document ID not found, skipping chunk creation');
            continue;
          }

          const chunks = this.chunker.chunkDocument(doc.content);
          
          for (const chunk of chunks) {
            allChunks.push({
              document_id: documentId,
              chunk_index: chunk.chunkIndex,
              content: chunk.content,
              content_length: chunk.contentLength,
              start_char: chunk.startChar,
              end_char: chunk.endChar,
              archive_filename: doc.archiveFilename,
              member: doc.member,
              document_title: doc.title,
              document_date: doc.date,
              section_title: chunk.metadata.sectionTitle ?? null,
              section_number: chunk.metadata.sectionNumber ?? null
            });
          }
        }

        // Generate embeddings for chunks if embedding service is available
        if (this.embeddingService && allChunks.length > 0) {
          try {
            const chunkTexts = allChunks.map(c => c.content);
            const chunkEmbeddings = await this.embeddingService.generateEmbeddings(chunkTexts);
            
            for (let j = 0; j < allChunks.length && j < chunkEmbeddings.length; j++) {
              allChunks[j].embedding = chunkEmbeddings[j];
            }
          } catch (embeddingError) {
            this.logs.warn({ err: embeddingError }, 'Failed to generate chunk embeddings, inserting chunks without embeddings');
          }
        }

        // Insert chunks in batches
        for (let j = 0; j < allChunks.length; j += chunkBatchSize) {
          const chunkBatch = allChunks.slice(j, j + chunkBatchSize);
          const { error: chunkInsertError } = await this.supabase
            .from('document_chunks')
            .insert(chunkBatch);

          if (chunkInsertError) {
            this.logs.error(
              { err: chunkInsertError, archive: filename, chunkBatchStart: j },
              'Failed to insert chunk batch'
            );
            // Continue with other chunks rather than failing completely
          } else {
            totalChunks += chunkBatch.length;
          }
        }
      }

      chunkTimer.end({ totalChunks });
      this.logs.info({ archive: filename, documents: documents.length, chunks: totalChunks }, 'Created and inserted document chunks');

      this.logs.info({ archive: filename, documents: documents.length }, 'Replaced documents in Supabase');
      replaceTimer.end({ success: true, chunksCreated: totalChunks });
    } catch (error) {
      replaceTimer.end({ success: false });
      this.logs.error({ err: error, archive: filename }, 'Failed to replace documents - database may be inconsistent');
      throw error;
    }
  }

  startArchiveIngest(filename: string): ArchiveIngestSession {
    this.validateFilename(filename);
    
    const documents: ArchiveDocument[] = [];
    let finalized = false;
    let discarded = false;

    const addDocument = (doc: ArchiveDocument) => {
      if (finalized || discarded) {
        throw new Error('Archive ingest session already closed');
      }
      documents.push(doc);
    };

    const finalize = () => {
      if (finalized || discarded) {
        return;
      }
      finalized = true;
      // Fire-and-forget for compatibility with sync interface
      // In practice, callers should await the promise if needed
      this.replaceDocumentsAsync(filename, documents).catch(error => {
        this.logs.error({ err: error, archive: filename }, 'Failed to finalize archive ingest');
      });
    };

    const discard = (error?: unknown) => {
      if (finalized || discarded) {
        return;
      }
      discarded = true;
      if (error) {
        this.logs.error({ err: error, archive: filename }, 'Archive ingest discarded');
      }
    };

    return {
      addDocument,
      finalize,
      discard
    };
  }

  search(_query: string, _options: { limit: number; offset: number }): ArchiveSearchResult {
    // For compatibility, we'll return empty and log a warning
    // Callers should use async version
    this.logs.warn('Synchronous search() called on SupabaseArchiveStore - use searchAsync() instead');
    return { hits: [], total: 0 };
  }

  async searchAsync(query: string, options: { limit: number; offset: number }): Promise<ArchiveSearchResult> {
    const searchTimer = new Timer('db_search', this.logs, {
      query: query.substring(0, 100),
      queryLength: query.length,
      limit: options.limit,
      offset: options.offset,
      useHybridSearch: this.embeddingService !== null
    });

    // Validate query
    if (!query || typeof query !== 'string') {
      searchTimer.end({ hits: 0, total: 0, reason: 'empty_query' });
      return { hits: [], total: 0 };
    }

    // Validate pagination options
    const limit = Math.max(1, Math.min(options.limit || 10, 100)); // Clamp between 1 and 100
    const offset = Math.max(0, options.offset || 0);

    const tokens = extractQueryTokens(query.toLowerCase());
    if (tokens.length === 0) {
      searchTimer.end({ hits: 0, total: 0, reason: 'no_tokens' });
      return { hits: [], total: 0 };
    }

    // Build Postgres tsquery from tokens
    // Use prefix matching (:* ) for better recall on legal terms
    // Example: "lov:*" matches "lovdata", "lovgivning", etc.
    // Join with & (AND) for all terms must match
    const tsQuery = tokens.map(token => `${token}:*`).join(' & ');

    // Generate query embedding if hybrid search is available
    let queryEmbedding: number[] | null = null;
    if (this.embeddingService) {
      try {
        const embeddingTimer = new Timer('generate_query_embedding', this.logs, { query: query.substring(0, 100) });
        queryEmbedding = await this.embeddingService.generateEmbedding(query);
        embeddingTimer.end({ embeddingLength: queryEmbedding.length });
        this.logs.debug({ queryLength: query.length }, 'Generated query embedding for hybrid search');
      } catch (embeddingError) {
        // Log error but continue with FTS-only search
        this.logs.warn({ err: embeddingError }, 'Failed to generate query embedding - falling back to FTS-only search');
        queryEmbedding = null;
      }
    }

    // Single optimized query with count
    const queryTimer = new Timer('db_text_search', this.logs, { tsQuery, limit, offset });
    
    this.logs.info({ tsQuery, limit, offset }, 'searchAsync: executing database query');
    
    // Add timeout to prevent hanging (60 seconds max - matches Vercel Pro function timeout)
    // This gives queries plenty of time to complete while still preventing infinite hangs
    const timeoutMs = 60000;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let queryAborted = false;
    const queryStartTime = Date.now();
    
    this.logs.info({ timeoutMs }, 'searchAsync: setting up query with timeout');
    
    const queryPromise = (async () => {
      try {
        this.logs.info('searchAsync: starting Supabase query');
        console.log(`[SupabaseArchiveStore] Starting query: ${tsQuery}, limit: ${limit}, offset: ${offset}`);
        this.logs.info({ 
          table: 'lovdata_documents',
          tsQuery,
          limit,
          offset
        }, 'searchAsync: building query chain');
        
        // Use hybrid search if embeddings are available, otherwise fall back to FTS-only
        let rpcFunctionName: string;
        let rpcParams: any;
        
        // Use chunk-based search for better granularity
        if (queryEmbedding && this.embeddingService) {
          // Use hybrid search on chunks with RRF (Reciprocal Rank Fusion)
          rpcFunctionName = 'search_document_chunks_hybrid';
          rpcParams = {
            search_query: query,
            query_embedding: queryEmbedding,  // Pass as array directly
            result_limit: limit,
            result_offset: offset,
            rrf_k: 60  // RRF constant (typical value)
          };
          
          this.logs.info({ 
            rpcFunction: rpcFunctionName,
            queryLength: query.length,
            embeddingLength: queryEmbedding.length,
            limit,
            offset,
            searchType: 'chunks'
          }, 'searchAsync: using hybrid search on chunks (FTS + Vector) with RRF');
        } else {
          // Fall back to FTS-only search on chunks
          // Note: We could create a search_document_chunks_fts function, but for now
          // we'll use the document-level search as fallback
          rpcFunctionName = 'search_lovdata_documents';
          rpcParams = {
            search_query: tsQuery,
            result_limit: limit,
            result_offset: offset
          };
          
          this.logs.info({ 
            rpcFunction: rpcFunctionName,
            rpcParams,
            tsQuery,
            searchType: 'documents_fallback'
          }, 'searchAsync: using FTS-only search on documents (chunk search not available)');
        }
        
        // Add an additional timeout wrapper around the query itself
        // This ensures we catch hanging queries even if the outer Promise.race doesn't work
        // Use 30 seconds - reasonable timeout that leaves buffer for Vercel Pro 60s limit
        const queryTimeoutMs = 30000; // 30 seconds for the query itself - leaves 30s buffer for other operations
        let queryTimeoutHandle: NodeJS.Timeout | null = null;
        
        // Add safety checks to ensure we're still running
        setTimeout(() => {
          const elapsed = Date.now() - queryStartTime;
          console.log(`[SupabaseArchiveStore] 2 second safety check - elapsed: ${elapsed}ms (timeout should trigger at ${queryTimeoutMs}ms)`);
          this.logs.info({ elapsedMs: elapsed, queryTimeoutMs }, 'searchAsync: 2 second safety check - still running, timeout pending');
        }, 2000);
        
        setTimeout(() => {
          const elapsed = Date.now() - queryStartTime;
          console.log(`[SupabaseArchiveStore] 2.8 second safety check - elapsed: ${elapsed}ms (timeout will trigger in ~200ms at ${queryTimeoutMs}ms)`);
          this.logs.info({ elapsedMs: elapsed, queryTimeoutMs }, 'searchAsync: 2.8 second safety check - timeout about to trigger');
        }, 2800);
        
        try {
          this.logs.info({ queryTimeoutMs, queryStartTime }, 'searchAsync: awaiting RPC query with internal timeout');
          
          // Log right before Promise.race to ensure we get there
          const raceStartTime = Date.now();
          this.logs.info({ raceStartTime }, 'searchAsync: starting internal Promise.race');
          
          // Log right before we execute the RPC call
          console.log(`[SupabaseArchiveStore] About to execute RPC call...`);
          this.logs.info('searchAsync: executing RPC function');
          
          // Execute the RPC call and count query in parallel with timeout protection
          const queryExecutionPromise = (async () => {
            try {
              // Call the RPC function for results
              const rpcCallPromise = this.supabase.rpc(rpcFunctionName, rpcParams);
              
              // Also get the total count separately (RPC function may not return count)
              // We'll use a simple count query with the same search criteria
              const countQueryBuilder = this.supabase
      .from('lovdata_documents')
                .select('*', { count: 'exact', head: true })
      .textSearch('tsv_content', tsQuery, {
        type: 'plain',
        config: 'norwegian'
                });
              
              // Execute both queries in parallel
              const [rpcResult, countResult] = await Promise.all([
                rpcCallPromise,
                countQueryBuilder
              ]);
              
              // Handle RPC result
              if (rpcResult.error) {
                this.logs.error({ err: rpcResult.error, rpcFunction: rpcFunctionName }, 'searchAsync: RPC function failed');
                throw rpcResult.error;
              }
              
              // Handle count result
              const total = countResult.count ?? 0;
              
              // Map RPC result to expected format
              // Chunk search returns: { id, document_id, chunk_index, content, archive_filename, member, document_title, document_date, section_title, section_number, fts_rank, vector_distance, rrf_score }
              // Document search returns: { archive_filename, member, title, document_date, content, rank }
              const data = (rpcResult.data || []).map((row: any) => {
                // If this is a chunk result, use chunk-specific fields
                if (row.chunk_index !== undefined) {
                  return {
                    archive_filename: row.archive_filename,
                    member: row.member,
                    title: row.document_title || row.section_title || null, // Prefer section title if available
                    document_date: row.document_date,
                    content: row.content,
                    chunk_index: row.chunk_index,
                    section_title: row.section_title,
                    section_number: row.section_number
                  };
                } else {
                  // Document-level result (fallback)
                  return {
                    archive_filename: row.archive_filename,
                    member: row.member,
                    title: row.title,
                    document_date: row.document_date,
                    content: row.content
                  };
                }
              });
              
              // Return result in the same format as the original query
              const result = {
                data,
                error: null,
                count: total
              };
              
              const raceDuration = Date.now() - raceStartTime;
              console.log(`[SupabaseArchiveStore] RPC query completed after ${raceDuration}ms`);
              this.logs.info({ 
                raceDurationMs: raceDuration, 
                resolvedBy: 'query',
                resultCount: data.length,
                total
              }, 'searchAsync: internal Promise.race resolved - query won');
              
              return result;
            } catch (err: unknown) {
              const raceDuration = Date.now() - raceStartTime;
              console.log(`[SupabaseArchiveStore] RPC query failed after ${raceDuration}ms:`, err instanceof Error ? err.message : String(err));
              this.logs.error({ err, raceDurationMs: raceDuration }, 'searchAsync: RPC query failed');
              throw err;
            }
          })();
          
          console.log(`[SupabaseArchiveStore] Starting internal Promise.race, queryTimeoutMs: ${queryTimeoutMs}`);
          const internalRaceStartTime = Date.now();
          
          // Log right before timeout to confirm it's about to trigger
          setTimeout(() => {
            const elapsed = Date.now() - queryStartTime;
            console.log(`[SupabaseArchiveStore] 2.9 second check - elapsed: ${elapsed}ms (timeout will trigger in ~100ms at ${queryTimeoutMs}ms)`);
            this.logs.info({ elapsedMs: elapsed, queryTimeoutMs }, 'searchAsync: 2.9 second check - timeout about to trigger');
          }, 2900);
          
          // Create a timeout promise that resolves (not rejects) to make Promise.race work properly
          const timeoutWrapperPromise = new Promise<{ type: 'timeout'; error: Error }>((resolve) => {
            queryTimeoutHandle = setTimeout(() => {
              const raceDuration = Date.now() - internalRaceStartTime;
              const elapsed = Date.now() - queryStartTime;
              console.log(`[SupabaseArchiveStore] INTERNAL TIMEOUT TRIGGERED after ${elapsed}ms (race: ${raceDuration}ms)`);
              this.logs.error({ elapsedMs: elapsed, raceDurationMs: raceDuration, queryTimeoutMs }, 'searchAsync: query execution timed out (internal timeout)');
              resolve({ 
                type: 'timeout' as const, 
                error: new Error(`Query execution timed out after ${queryTimeoutMs}ms`) 
              });
            }, queryTimeoutMs);
          });
          
          const internalRacePromise = Promise.race([
            queryExecutionPromise.then(result => {
              const raceDuration = Date.now() - internalRaceStartTime;
              console.log(`[SupabaseArchiveStore] INTERNAL RACE: Query won after ${raceDuration}ms`);
              if (queryTimeoutHandle) {
                clearTimeout(queryTimeoutHandle);
              }
              return { type: 'success' as const, result };
            }),
            timeoutWrapperPromise.then(timeoutResult => {
              const raceDuration = Date.now() - internalRaceStartTime;
              console.log(`[SupabaseArchiveStore] INTERNAL RACE: Timeout won after ${raceDuration}ms`);
              this.logs.info({ raceDurationMs: raceDuration, resolvedBy: 'timeout' }, 'searchAsync: internal Promise.race resolved - timeout won');
              return timeoutResult;
            })
          ]);
          
          console.log(`[SupabaseArchiveStore] Awaiting internal race result...`);
          const internalRaceResult = await internalRacePromise;
          
          if (internalRaceResult.type === 'timeout') {
            console.log(`[SupabaseArchiveStore] Internal race resolved with timeout, throwing error`);
            throw internalRaceResult.error;
          }
          
          console.log(`[SupabaseArchiveStore] Internal race resolved with success, result has data: ${!!internalRaceResult.result?.data}`);
          const result = internalRaceResult.result;
          
          if (queryTimeoutHandle) {
            clearTimeout(queryTimeoutHandle);
          }
          
          const queryDuration = Date.now() - queryStartTime;
          this.logs.info({ queryDurationMs: queryDuration }, 'searchAsync: RPC query promise resolved');
          
          if (queryAborted) {
            this.logs.warn('searchAsync: query completed but was already aborted');
            throw new Error('Query was aborted due to timeout');
          }
          
          this.logs.info({ 
            hasData: !!result.data,
            dataLength: result.data?.length ?? 0,
            hasError: !!result.error,
            count: result.count
          }, 'searchAsync: query completed');
          
          return result;
        } catch (queryTimeoutError) {
          if (queryTimeoutHandle) {
            clearTimeout(queryTimeoutHandle);
          }
          // Re-throw the timeout error so outer error handling can catch it
          throw queryTimeoutError;
        }
      } catch (queryError) {
        const queryDuration = Date.now() - queryStartTime;
        if (!queryAborted) {
          this.logs.error({ err: queryError, queryDurationMs: queryDuration }, 'searchAsync: query error');
        } else {
          this.logs.warn({ queryDurationMs: queryDuration }, 'searchAsync: query error (aborted)');
        }
        throw queryError;
      }
    })();
    
    const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        const elapsed = Date.now() - queryStartTime;
        queryAborted = true;
        this.logs.warn({ elapsedMs: elapsed, timeoutMs }, 'searchAsync: timeout triggered');
        resolve({ type: 'timeout' });
      }, timeoutMs);
    });
    
    let data: any[] | null | undefined;
    let error: any | null | undefined;
    let count: number | null | undefined;
    try {
      this.logs.info({ queryStartTime, timeoutMs }, 'searchAsync: waiting for query result with timeout');
      
      // Log immediately before setting up Promise.race
      this.logs.info({ elapsedMs: 0 }, 'searchAsync: progress check - starting Promise.race');
      
      // Add a safety check - log periodically to see if we're still waiting
      // Use info level to ensure it shows up in Vercel logs
      // Log every 5 seconds for longer timeout
      // Also log more frequently to catch issues early
      this.logs.info('searchAsync: setting up progress interval');
      const progressInterval = setInterval(() => {
        const elapsed = Date.now() - queryStartTime;
        this.logs.info({ elapsedMs: elapsed, timeoutMs, progress: `${Math.round((elapsed / timeoutMs) * 100)}%` }, 'searchAsync: still waiting for query (progress check)');
      }, 5000);
      
      // Also log after 1, 3, and 5 seconds to track progress
      setTimeout(() => {
        const elapsed = Date.now() - queryStartTime;
        console.log(`[SupabaseArchiveStore] 1 second check - elapsed: ${elapsed}ms`);
        this.logs.info({ elapsedMs: elapsed }, 'searchAsync: 1 second check - function still running');
      }, 1000);
      
      setTimeout(() => {
        const elapsed = Date.now() - queryStartTime;
        console.log(`[SupabaseArchiveStore] 3 second check - elapsed: ${elapsed}ms`);
        this.logs.info({ elapsedMs: elapsed }, 'searchAsync: 3 second check - function still running');
      }, 3000);
      
      setTimeout(() => {
        const elapsed = Date.now() - queryStartTime;
        console.log(`[SupabaseArchiveStore] 5 second check - elapsed: ${elapsed}ms`);
        this.logs.info({ elapsedMs: elapsed }, 'searchAsync: 5 second check - function still running');
      }, 5000);
      
      this.logs.info('searchAsync: progress interval and timed checks set up');
      
      // Use a wrapper that ensures timeout always triggers
      console.log(`[SupabaseArchiveStore] Starting Promise.race for query, timeout: ${timeoutMs}ms`);
      const racePromise = Promise.race([
        queryPromise.then(result => {
          const elapsed = Date.now() - queryStartTime;
          console.log(`[SupabaseArchiveStore] Query promise resolved after ${elapsed}ms`);
          this.logs.info('searchAsync: query promise resolved first');
          return { type: 'success' as const, result };
        }),
        timeoutPromise.then(() => {
          const elapsed = Date.now() - queryStartTime;
          console.log(`[SupabaseArchiveStore] Timeout promise resolved after ${elapsed}ms`);
          this.logs.info('searchAsync: timeout promise resolved first');
          return { type: 'timeout' as const };
        })
      ]);
      
      console.log(`[SupabaseArchiveStore] Awaiting Promise.race result...`);
      const raceResult = await racePromise;
      console.log(`[SupabaseArchiveStore] Promise.race completed, result type: ${raceResult.type}`);
      clearInterval(progressInterval);
      this.logs.info({ resultType: raceResult.type }, 'searchAsync: Promise.race completed, cleaning up interval');
      
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      
      if (raceResult.type === 'timeout') {
        const elapsed = Date.now() - queryStartTime;
        this.logs.error({ 
          elapsedMs: elapsed,
          query, 
          tsQuery, 
          limit, 
          offset 
        }, 'searchAsync: timeout reached in Promise.race');
        queryTimer.end({ success: false, error: 'timeout' });
        searchTimer.end({ success: false, error: 'timeout' });
        return { hits: [], total: 0 };
      }
      
      this.logs.info('searchAsync: Promise.race completed successfully');
      const result = raceResult.result;
      data = result.data;
      error = result.error;
      count = result.count;
    } catch (timeoutError) {
      const elapsed = Date.now() - queryStartTime;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.logs.error({ 
        err: timeoutError, 
        elapsedMs: elapsed,
        query, 
        tsQuery, 
        limit, 
        offset 
      }, 'searchAsync: Promise.race rejected (timeout or error)');
      queryTimer.end({ success: false, error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError) });
      searchTimer.end({ success: false, error: 'timeout' });
      console.log(`[SupabaseArchiveStore] Returning empty results due to timeout/error`);
      this.logs.info('searchAsync: returning empty results due to timeout');
      return { hits: [], total: 0 };
    }
    
    queryTimer.end({ resultCount: data?.length ?? 0, totalCount: count ?? 0 });
    
    this.logs.info({ 
      hasData: !!data,
      dataLength: data?.length ?? 0,
      hasError: !!error,
      count 
    }, 'searchAsync: about to check for errors');

    if (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      searchTimer.end({ success: false, error: errorMessage });
      this.logs.error({ err: error, query }, 'Failed to search documents');
      this.logs.info('searchAsync: returning empty hits due to error');
      return { hits: [], total: 0 };
    }
    
    this.logs.info('searchAsync: no error, processing results');

    // For chunk searches, count may not be available, so use data length if we have data
    // For document searches, count should be available from the RPC function
    const total = count ?? (data && data.length > 0 ? data.length : 0);
    this.logs.info({ total, count, dataLength: data?.length ?? 0 }, 'searchAsync: checking if results are empty');
    
    // If we have data, use it even if count is 0 (chunk searches don't return count)
    if (!data || data.length === 0) {
      searchTimer.end({ hits: 0, total: 0 });
      this.logs.info('searchAsync: returning empty results (no data)');
      return { hits: [], total: 0 };
    }
    
    // If we have data but count is 0, use data length as total
    const effectiveTotal = count && count > 0 ? count : data.length;
    
    this.logs.info({ dataLength: data.length, total }, 'searchAsync: processing non-empty results');

    // Generate snippets from content
    const snippetTimer = new Timer('generate_snippets', this.logs, { documentCount: data.length });
    const hits: ArchiveSearchHit[] = data.map((doc: any) => {
      // For chunks, use the chunk content directly (it's already a focused snippet)
      // For full documents, generate a snippet
      let snippet: string;
      if (doc.chunk_index !== undefined) {
        // Chunk result - use chunk content as snippet (truncate if needed)
        snippet = doc.content.length > 300 
          ? doc.content.substring(0, 297) + '...'
          : doc.content;
        
        // Add section info to title if available
        let displayTitle = doc.title;
        if (doc.section_number) {
          displayTitle = displayTitle 
            ? `${displayTitle} (${doc.section_number})`
            : `§ ${doc.section_number}`;
        }
        
        return {
          filename: doc.archive_filename,
          member: doc.member,
          title: displayTitle,
          date: doc.document_date,
          snippet
        };
      } else {
        // Document-level result - generate snippet
        snippet = this.generateSnippet(doc.content, tokens, 150);
        return {
          filename: doc.archive_filename,
          member: doc.member,
          title: doc.title,
          date: doc.document_date,
          snippet
        };
      }
    });
    snippetTimer.end({ snippetCount: hits.length });

    searchTimer.end({ hits: hits.length, total: effectiveTotal });
    
    this.logs.info({ 
      hitsCount: hits.length,
      total: effectiveTotal,
      originalCount: count
    }, 'searchAsync: returning final results');

    return { hits, total: effectiveTotal };
  }

  private generateSnippet(content: string, tokens: string[], maxLength: number): string {
    const lowerContent = content.toLowerCase();
    let bestStart = 0;
    let bestScore = 0;

    // Find the position with most token matches
    for (let i = 0; i < Math.min(content.length, 10000); i += 100) {
      const window = lowerContent.substring(i, i + maxLength);
      const score = tokens.reduce((acc, token) => {
        return acc + (window.includes(token) ? 1 : 0);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
      }
    }

    let snippet = content.substring(bestStart, bestStart + maxLength);
    if (bestStart > 0) {
      snippet = '…' + snippet;
    }
    if (bestStart + maxLength < content.length) {
      snippet = snippet + '…';
    }

    return snippet.trim();
  }

  getDocumentContent(_filename: string, _member: string): string | null {
    // Synchronous version - returns null, use async version
    this.logs.warn('Synchronous getDocumentContent() called - use getDocumentContentAsync() instead');
    return null;
  }

  async getDocumentContentAsync(filename: string, member: string): Promise<string | null> {
    const fetchTimer = new Timer('get_document_content', this.logs, { filename, member });
    this.validateFilename(filename);
    this.validateMember(member);

    // Add timeout to prevent hanging (5 seconds)
    const timeoutMs = 5000;
    const fetchStartTime = Date.now();
    
    this.logs.info({ filename, member, timeoutMs }, 'getDocumentContentAsync: starting fetch with timeout');

    const queryPromise = (async () => {
      try {
        this.logs.info({ filename, member }, 'getDocumentContentAsync: executing Supabase query');
        const queryStartTime = Date.now();

    const { data, error } = await this.supabase
      .from('lovdata_documents')
      .select('content')
      .eq('archive_filename', filename)
      .eq('member', member)
      .maybeSingle();

        const fetchDuration = Date.now() - fetchStartTime;
        this.logs.info({ 
          fetchDurationMs: fetchDuration, 
          hasError: !!error, 
          hasData: !!data,
          contentLength: data?.content?.length ?? 0
        }, 'getDocumentContentAsync: query completed');

    if (error) {
      fetchTimer.end({ success: false, found: false, error: error.message });
      this.logs.error({ err: error, filename, member }, 'Failed to fetch document content');
      return null;
    }

    if (!data) {
      fetchTimer.end({ success: true, found: false });
      return null;
    }

    const contentLength = data.content?.length ?? 0;
    fetchTimer.end({ success: true, found: true, contentLength });
    return data.content;
      } catch (queryError) {
        const fetchDuration = Date.now() - fetchStartTime;
        this.logs.error({ err: queryError, fetchDurationMs: fetchDuration }, 'getDocumentContentAsync: query error');
        throw queryError;
      }
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        const elapsed = Date.now() - fetchStartTime;
        this.logs.error({ elapsedMs: elapsed, timeoutMs, filename, member }, 'getDocumentContentAsync: fetch timed out');
        reject(new Error(`Document content fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([queryPromise, timeoutPromise]);
      return result;
    } catch (timeoutError) {
      fetchTimer.end({ success: false, found: false, error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError) });
      // Return null on timeout - the calling code should handle this gracefully
      return null;
    }
  }

  getDocument(_filename: string, _member: string): ArchiveDocumentRecord | null {
    // Synchronous version - returns null, use async version
    this.logs.warn('Synchronous getDocument() called - use getDocumentAsync() instead');
    return null;
  }

  async getDocumentAsync(filename: string, member: string): Promise<ArchiveDocumentRecord | null> {
    this.validateFilename(filename);
    this.validateMember(member);

    try {
    const { data, error } = await this.supabase
      .from('lovdata_documents')
      .select('content, title, document_date, relative_path')
      .eq('archive_filename', filename)
      .eq('member', member)
      .maybeSingle();

    if (error) {
        // Log Supabase errors with more detail
        this.logs.error({ 
          err: error, 
          filename, 
          member,
          errorCode: (error as any)?.code,
          errorMessage: (error as any)?.message,
          errorDetails: (error as any)?.details,
          errorHint: (error as any)?.hint
        }, 'Failed to fetch document from Supabase');
      return null;
    }

    if (!data) {
        this.logs.debug({ filename, member }, 'Document not found in Supabase');
      return null;
    }

    return {
      content: data.content,
      title: data.title,
      date: data.document_date,
      relativePath: data.relative_path
    };
    } catch (queryError) {
      // Handle unexpected errors
      this.logs.error({ 
        err: queryError, 
        filename, 
        member,
        errorType: queryError instanceof Error ? queryError.constructor.name : typeof queryError
      }, 'Unexpected error in getDocumentAsync');
      return null;
    }
  }

  async prepareDocumentFile(
    filename: string,
    member: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    this.validateFilename(filename);
    this.validateMember(member);

    // Sanitize paths to prevent path traversal
    const safeFilename = this.sanitizeStoragePath(filename);
    const safeMember = this.sanitizeStoragePath(member);
    const relativePath = `${safeFilename}/${safeMember}`;
    
    return {
      absolutePath: `lovdata-documents/${relativePath}`,
      relativePath
    };
  }

  async readDocumentText(filename: string, member: string): Promise<string | null> {
    this.validateFilename(filename);
    this.validateMember(member);

    // First try to get from database
    const record = await this.getDocumentAsync(filename, member);
    if (record) {
      return record.content;
    }

    // Fallback: try to read from Supabase Storage
    try {
      // Sanitize paths to prevent path traversal
      const safeFilename = this.sanitizeStoragePath(filename);
      const safeMember = this.sanitizeStoragePath(member);
      const storagePath = `lovdata-documents/${safeFilename}/${safeMember}`;
      
      const { data, error } = await this.supabase.storage.from('lovdata-documents').download(storagePath);

      if (error || !data) {
        this.logs.warn({ err: error, filename, member }, 'Failed to read document from Supabase Storage');
        return null;
      }

      const text = await data.text();
      return text;
    } catch (error) {
      this.logs.warn({ err: error, filename, member }, 'Failed to read document from storage');
      return null;
    }
  }
}

