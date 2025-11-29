/**
 * Automatic archive ingestion service for Supabase.
 * 
 * This service fetches new archives from lovdata-api, processes them,
 * and stores them in Supabase (both Postgres and Storage).
 * 
 * Usage:
 *   - Call syncArchives() on startup or via scheduled job
 *   - It will check for new archives and process them automatically
 */

import { Readable } from 'node:stream';
import tarStream from 'tar-stream';
import unzipper from 'unzipper';
import bz2 from 'unbzip2-stream';
import { TextDecoder } from 'node:util';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger.js';
import { LovdataClient } from './lovdataClient.js';
import { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';
import type { ArchiveDocument } from '../storage/types.js';
import { Timer, timeOperation } from '../utils/timing.js';

export interface SyncOptions {
  logger?: Logger;
  skipStorageUpload?: boolean; // If true, only update Postgres, skip Storage upload
}

/**
 * Syncs archives from lovdata-api to Supabase.
 * Checks for new archives and processes any that haven't been processed yet.
 */
export async function syncArchives(
  client: LovdataClient,
  store: SupabaseArchiveStore,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const logs = options.logger ?? defaultLogger;
  const syncTimer = new Timer('archive_sync', logs);
  const result: SyncResult = {
    checked: 0,
    processed: 0,
    skipped: 0,
    errors: []
  };

  try {
    logs.info('Starting archive sync from lovdata-api');

    // Get list of available archives
    const listingTimer = new Timer('list_public_data', logs);
    const listing = await client.listPublicData();
    listingTimer.end({ fileCount: listing.files.length });
    result.checked = listing.files.length;

    logs.info({ archiveCount: listing.files.length }, 'Found archives in lovdata-api');

    // Process each archive
    for (const filename of listing.files) {
      try {
        // Check if already processed
        const checkTimer = new Timer('check_archive_processed', logs, { filename });
        const isProcessed = await store.isArchiveProcessedAsync(filename);
        checkTimer.end({ isProcessed });
        
        if (isProcessed) {
          logs.debug({ filename }, 'Archive already processed, skipping');
          result.skipped++;
          continue;
        }

        logs.info({ filename }, 'Processing new archive');

        // Fetch and process the archive
        await timeOperation(
          'process_archive',
          () => processArchive(client, store, filename, logs, options.skipStorageUpload ?? false),
          logs,
          { filename }
        );
        result.processed++;

        logs.info({ filename }, 'Archive processed successfully');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logs.error({ err: error, filename }, 'Failed to process archive');
        result.errors.push({ filename, error: errorMsg });
      }
    }

    syncTimer.end({
      checked: result.checked,
      processed: result.processed,
      skipped: result.skipped,
      errors: result.errors.length
    });

    logs.info(
      {
        checked: result.checked,
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors.length
      },
      'Archive sync completed'
    );

    return result;
  } catch (error) {
    syncTimer.end({ success: false });
    logs.error({ err: error }, 'Archive sync failed');
    throw error;
  }
}

export interface SyncResult {
  checked: number;
  processed: number;
  skipped: number;
  errors: Array<{ filename: string; error: string }>;
}

async function processArchive(
  client: LovdataClient,
  store: SupabaseArchiveStore,
  filename: string,
  logs: Logger,
  _skipStorageUpload: boolean
): Promise<void> {
  const archiveTimer = new Timer('process_archive', logs, { filename });
  
  const fetchTimer = new Timer('fetch_archive_stream', logs, { filename });
  const { stream } = await client.getBinaryStream(`/v1/public/get/${filename}`);
  fetchTimer.end();
  
  const documents: ArchiveDocument[] = [];
  let documentCount = 0;

  try {
    const streamTimer = new Timer('process_archive_stream', logs, { filename });
    await processArchiveStream(filename, stream, async (entryStream, entryName) => {
      if (!isSearchableEntry(entryName)) {
        entryStream.resume();
        return;
      }

      // Prepare document file path (for storage)
      const { relativePath } = await store.prepareDocumentFile(filename, entryName);

      // Extract and decode content
      const decoder = new TextDecoder('utf-8');
      let rawText = '';

      // Read and decode the entry stream
      for await (const chunk of entryStream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rawText += decoder.decode(buffer, { stream: true });
      }
      rawText += decoder.decode(new Uint8Array(), { stream: false });

      // Normalize and extract metadata
      const normalized = normalizeDocumentText(rawText);
      const title = extractTitle(rawText);
      const date = extractDate(rawText);
      const document: ArchiveDocument = {
        archiveFilename: filename,
        member: entryName,
        title,
        date,
        content: normalized,
        relativePath,
        year: extractYear(rawText, date),
        lawType: extractLawType(rawText, title),
        ministry: extractMinistry(rawText, title)
      };

      documents.push(document);
      documentCount++;
      
      // Log progress every 100 documents
      if (documentCount % 100 === 0) {
        streamTimer.checkpoint(`processed_${documentCount}_documents`);
      }
    });
    streamTimer.end({ documentCount });

    // Save to Supabase Postgres
    const saveTimer = new Timer('save_documents_to_db', logs, { filename, documentCount: documents.length });
    await store.replaceDocumentsAsync(filename, documents);
    saveTimer.end();
    
    logs.info({ filename, documentCount: documents.length }, 'Archive documents saved to Supabase');

    // TODO: Upload archive files to Supabase Storage if !skipStorageUpload
    // This would require re-fetching the archive or storing it temporarily
    // For now, storage upload should be done separately via upload-lovdata-storage script
    
    archiveTimer.end({ documentCount: documents.length });
  } catch (error) {
    archiveTimer.end({ success: false, documentCount });
    logs.error({ err: error, filename }, 'Failed to process archive');
    throw error;
  }
}

async function processArchiveStream(
  filename: string,
  stream: Readable,
  handler: (entryStream: Readable, entryName: string) => Promise<void>
): Promise<void> {
  if (filename.endsWith('.tar.bz2') || filename.endsWith('.tbz2')) {
    await processTarBz2Stream(stream, handler);
    return;
  }

  if (filename.endsWith('.zip')) {
    await processZipStream(stream, handler);
    return;
  }

  // Treat as a single file stream
  await handler(stream, filename);
}

async function processZipStream(
  stream: Readable,
  handler: (entryStream: Readable, entryName: string) => Promise<void>
): Promise<void> {
  const parser = unzipper.Parse({ forceStream: true });
  stream.pipe(parser);

  try {
    for await (const entry of parser) {
      if (entry.type !== 'File') {
        entry.autodrain();
        continue;
      }
      await handler(entry as unknown as Readable, entry.path);
    }
  } finally {
    if (typeof stream.unpipe === 'function') {
      stream.unpipe(parser);
    }
    parser.destroy();
  }
}

async function processTarBz2Stream(
  stream: Readable,
  handler: (entryStream: Readable, entryName: string) => Promise<void>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const extract = tarStream.extract();
    const decoder = bz2();

    const handleError = (error: unknown) => {
      extract.destroy(error as Error);
      decoder.destroy(error as Error);
      reject(error as Error);
    };

    extract.on('entry', (header, entryStream, next) => {
      if (header.type !== 'file') {
        entryStream.resume();
        entryStream.once('end', next);
        entryStream.once('error', handleError);
        return;
      }

      (async () => {
        try {
          await handler(entryStream as Readable, header.name);
          next();
        } catch (error) {
          handleError(error);
        }
      })();
    });

    extract.once('finish', resolve);
    extract.once('error', handleError);

    stream
      .pipe(decoder)
      .on('error', handleError)
      .pipe(extract)
      .on('error', handleError);
  });
}

function isSearchableEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.xml') || lower.endsWith('.html') || lower.endsWith('.htm');
}

function normalizeDocumentText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(text: string): string | null {
  const patterns = [
    /<tittel[^>]*>([^<]{1,200})/i,
    /<tittel1[^>]*>([^<]{1,200})/i,
    /<title[^>]*>([^<]{1,200})/i,
    /<overskrift[^>]*>([^<]{1,200})/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      return decodeXmlEntities(match[1].trim());
    }
  }
  return null;
}

function extractDate(text: string): string | null {
  const patterns = [
    /<dato[^>]*>([^<]{1,50})/i,
    /<ikrafttredelse[^>]*>([^<]{1,50})/i,
    /<kunngjort[^>]*>([^<]{1,50})/i,
    /<published[^>]*>([^<]{1,50})/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      return decodeXmlEntities(match[1].trim());
    }
  }
  return null;
}

/**
 * Extracts the year from a date string or document content.
 * Looks for 4-digit years (1900-2100 range).
 */
function extractYear(text: string, dateStr: string | null): number | null {
  // First try to extract from date string
  if (dateStr) {
    const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      const year = parseInt(yearMatch[0], 10);
      if (year >= 1900 && year <= 2100) {
        return year;
      }
    }
  }
  
  // Fallback: search in document content for year patterns
  const yearPatterns = [
    /\b(19|20)\d{2}\b/,  // 4-digit years
    /år[:\s]+(\d{4})/i,  // "år: 2023" or "år 2023"
    /(\d{4})\s*år/i      // "2023 år"
  ];
  
  for (const pattern of yearPatterns) {
    const match = pattern.exec(text);
    if (match) {
      const yearStr = match[1] || match[0];
      const year = parseInt(yearStr, 10);
      if (year >= 1900 && year <= 2100) {
        return year;
      }
    }
  }
  
  return null;
}

/**
 * Extracts law type from document content.
 * Looks for common Norwegian law type indicators.
 */
function extractLawType(text: string, title: string | null): string | null {
  const searchText = (title ? title + ' ' : '') + text;
  const lowerText = searchText.toLowerCase();
  
  // Common law type patterns in Norwegian legal documents
  const lawTypePatterns = [
    { pattern: /\b(lov|act)\b/i, type: 'Lov' },
    { pattern: /\b(forskrift|regulation)\b/i, type: 'Forskrift' },
    { pattern: /\b(vedtak|decision)\b/i, type: 'Vedtak' },
    { pattern: /\b(cirkulær|circular)\b/i, type: 'Cirkulær' },
    { pattern: /\b(rundskriv|circular letter)\b/i, type: 'Rundskriv' },
    { pattern: /\b(instruks|instruction)\b/i, type: 'Instruks' },
    { pattern: /\b(reglement|regulations)\b/i, type: 'Reglement' },
    { pattern: /\b(vedlegg|annex|appendix)\b/i, type: 'Vedlegg' }
  ];
  
  // Check title first (more reliable)
  if (title) {
    for (const { pattern, type } of lawTypePatterns) {
      if (pattern.test(title)) {
        return type;
      }
    }
  }
  
  // Check content
  for (const { pattern, type } of lawTypePatterns) {
    if (pattern.test(lowerText)) {
      return type;
    }
  }
  
  // Check for specific law name patterns (e.g., "Folketrygdloven", "Arbeidsmiljøloven")
  const lawNamePattern = /\b([A-ZÆØÅ][a-zæøå]+loven?)\b/;
  const lawNameMatch = searchText.match(lawNamePattern);
  if (lawNameMatch) {
    return 'Lov';
  }
  
  return null;
}

/**
 * Extracts ministry/department from document content.
 * Looks for common Norwegian ministry names and abbreviations.
 */
function extractMinistry(text: string, title: string | null): string | null {
  const searchText = (title ? title + ' ' : '') + text;
  const lowerText = searchText.toLowerCase();
  
  // Common Norwegian ministries
  const ministries = [
    { patterns: [/\b(arbeids-?\s*og\s*sosialdepartementet|asd|arbeidsdepartementet)\b/i], name: 'Arbeids- og sosialdepartementet' },
    { patterns: [/\b(barne-?\s*og\s*familiedepartementet|bfd|barnefamiliedepartementet)\b/i], name: 'Barne- og familiedepartementet' },
    { patterns: [/\b(digitaliserings-?\s*og\s*forvaltningsdepartementet|dfd)\b/i], name: 'Digitaliserings- og forvaltningsdepartementet' },
    { patterns: [/\b(finansdepartementet|fd)\b/i], name: 'Finansdepartementet' },
    { patterns: [/\b(forsvarsdepartementet|fd)\b/i], name: 'Forsvarsdepartementet' },
    { patterns: [/\b(helse-?\s*og\s*omsorgsdepartementet|hod)\b/i], name: 'Helse- og omsorgsdepartementet' },
    { patterns: [/\b(justis-?\s*og\s*beredskapsdepartementet|jbd)\b/i], name: 'Justis- og beredskapsdepartementet' },
    { patterns: [/\b(klima-?\s*og\s*miljødepartementet|kmd)\b/i], name: 'Klima- og miljødepartementet' },
    { patterns: [/\b(kommunal-?\s*og\s*distriktsdepartementet|kdd)\b/i], name: 'Kommunal- og distriktsdepartementet' },
    { patterns: [/\b(kultur-?\s*og\s*likestillingsdepartementet|kld)\b/i], name: 'Kultur- og likestillingsdepartementet' },
    { patterns: [/\b(nærings-?\s*og\s*fiskeridepartementet|nfd)\b/i], name: 'Nærings- og fiskeridepartementet' },
    { patterns: [/\b(olje-?\s*og\s*energidepartementet|oed)\b/i], name: 'Olje- og energidepartementet' },
    { patterns: [/\b(samferdselsdepartementet|sfd)\b/i], name: 'Samferdselsdepartementet' },
    { patterns: [/\b(utdannings-?\s*og\s*forskningsdepartementet|ufd)\b/i], name: 'Utdannings- og forskningsdepartementet' },
    { patterns: [/\b(utenriksdepartementet|ud)\b/i], name: 'Utenriksdepartementet' }
  ];
  
  // Check for ministry mentions
  for (const ministry of ministries) {
    for (const pattern of ministry.patterns) {
      if (pattern.test(lowerText)) {
        return ministry.name;
      }
    }
  }
  
  // Generic pattern for "departementet" or "departement"
  const genericPattern = /\b([A-ZÆØÅ][a-zæøå]+(?:-?\s*og\s*[a-zæøå]+)?departementet?)\b/i;
  const genericMatch = searchText.match(genericPattern);
  if (genericMatch) {
    return genericMatch[1];
  }
  
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

