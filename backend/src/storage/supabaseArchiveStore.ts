import path from 'node:path';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
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
  private initialized = false;

  constructor(options?: { logger?: Logger }) {
    this.logs = options?.logger ?? defaultLogger;
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

      // Step 3: Insert documents in batches
      const batchSize = 500;
      const batchCount = Math.ceil(documents.length / batchSize);
      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        const batchTimer = new Timer('insert_documents_batch', this.logs, {
          filename,
          batchIndex: Math.floor(i / batchSize) + 1,
          batchCount,
          batchSize: batch.length
        });
        
        const rows = batch.map(doc => ({
          archive_filename: doc.archiveFilename,
          member: doc.member,
          title: doc.title,
          document_date: doc.date,
          content: doc.content,
          relative_path: doc.relativePath
        }));

        const { error: insertError } = await this.supabase.from('lovdata_documents').insert(rows);
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
      }

      this.logs.info({ archive: filename, documents: documents.length }, 'Replaced documents in Supabase');
      replaceTimer.end({ success: true });
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
      offset: options.offset
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
    // Join tokens with & (AND) and add :* for prefix matching
    const tsQuery = tokens.map(token => `${token}:*`).join(' & ');

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
        
        const queryBuilder = this.supabase
          .from('lovdata_documents')
          .select('archive_filename, member, title, document_date, content', { count: 'exact' })
          .textSearch('tsv_content', tsQuery, {
            type: 'plain',
            config: 'norwegian'
          })
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1);
        
        this.logs.info('searchAsync: query chain built, awaiting result');
        
        // Add an additional timeout wrapper around the query itself
        // This ensures we catch hanging queries even if the outer Promise.race doesn't work
        // Use 7 seconds to ensure timeout triggers well before Vercel Hobby tier 10s limit
        const queryTimeoutMs = 7000; // 7 seconds for the query itself
        let queryTimeoutHandle: NodeJS.Timeout | null = null;
        const queryTimeoutPromise = new Promise<never>((_, reject) => {
          queryTimeoutHandle = setTimeout(() => {
            const elapsed = Date.now() - queryStartTime;
            this.logs.error({ elapsedMs: elapsed, queryTimeoutMs }, 'searchAsync: query execution timed out (internal timeout)');
            reject(new Error(`Query execution timed out after ${queryTimeoutMs}ms`));
          }, queryTimeoutMs);
        });
        
        try {
          this.logs.info({ queryTimeoutMs, queryStartTime }, 'searchAsync: awaiting query with internal timeout');
          
          // Log right before Promise.race to ensure we get there
          const raceStartTime = Date.now();
          this.logs.info({ raceStartTime }, 'searchAsync: starting internal Promise.race');
          
          const result = await Promise.race([
            queryBuilder.then(r => {
              const raceDuration = Date.now() - raceStartTime;
              this.logs.info({ raceDurationMs: raceDuration, resolvedBy: 'query' }, 'searchAsync: internal Promise.race resolved - query won');
              return r;
            }),
            queryTimeoutPromise.then(() => {
              const raceDuration = Date.now() - raceStartTime;
              this.logs.info({ raceDurationMs: raceDuration, resolvedBy: 'timeout' }, 'searchAsync: internal Promise.race resolved - timeout won');
              throw new Error('Internal query timeout');
            })
          ]);
          
          if (queryTimeoutHandle) {
            clearTimeout(queryTimeoutHandle);
          }
          
          const queryDuration = Date.now() - queryStartTime;
          this.logs.info({ queryDurationMs: queryDuration }, 'searchAsync: Supabase query promise resolved');
          
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
    
    let data, error, count;
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
      searchTimer.end({ success: false, error: error.message });
      this.logs.error({ err: error, query }, 'Failed to search documents');
      this.logs.info('searchAsync: returning empty hits due to error');
      return { hits: [], total: 0 };
    }
    
    this.logs.info('searchAsync: no error, processing results');

    const total = count ?? 0;
    this.logs.info({ total, dataLength: data?.length ?? 0 }, 'searchAsync: checking if results are empty');
    
    if (total === 0 || !data || data.length === 0) {
      searchTimer.end({ hits: 0, total: 0 });
      this.logs.info('searchAsync: returning empty results (no data)');
      return { hits: [], total: 0 };
    }
    
    this.logs.info({ dataLength: data.length, total }, 'searchAsync: processing non-empty results');

    // Generate snippets from content
    const snippetTimer = new Timer('generate_snippets', this.logs, { documentCount: data.length });
    const hits: ArchiveSearchHit[] = data.map(doc => {
      const snippet = this.generateSnippet(doc.content, tokens, 150);
      return {
        filename: doc.archive_filename,
        member: doc.member,
        title: doc.title,
        date: doc.document_date,
        snippet
      };
    });
    snippetTimer.end({ snippetCount: hits.length });

    searchTimer.end({ hits: hits.length, total });
    
    this.logs.info({ 
      hitsCount: hits.length,
      total
    }, 'searchAsync: returning final results');

    return { hits, total };
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

    const { data, error } = await this.supabase
      .from('lovdata_documents')
      .select('content, title, document_date, relative_path')
      .eq('archive_filename', filename)
      .eq('member', member)
      .maybeSingle();

    if (error) {
      this.logs.error({ err: error, filename, member }, 'Failed to fetch document');
      return null;
    }

    if (!data) {
      return null;
    }

    return {
      content: data.content,
      title: data.title,
      date: data.document_date,
      relativePath: data.relative_path
    };
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

