import 'dotenv/config';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import type { PostgrestSingleResponse } from '@supabase/supabase-js';

type ImportOptions = {
  supabaseUrl: string;
  serviceRoleKey: string;
  inputDir: string;
  batchSize: number;
  dryRun: boolean;
};

type ArchivePayload = {
  filename: string;
  processedAt: string;
  documentCount: number;
};

type DocumentPayload = {
  archiveFilename: string;
  member: string;
  title: string | null;
  documentDate: string | null;
  content: string;
  relativePath: string;
};

type JsonlIterator<T> = AsyncGenerator<T, void, unknown>;

function parseArgs(): ImportOptions {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. Aborting.');
    process.exit(1);
  }

  const defaults: ImportOptions = {
    supabaseUrl,
    serviceRoleKey,
    inputDir: path.resolve(process.cwd(), 'tmp', 'migration-test'),
    batchSize: 500,
    dryRun: false
  };

  const args = process.argv.slice(2);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    switch (arg) {
      case '--dir':
      case '--input': {
        const value = args[idx + 1];
        if (!value) {
          throw new Error(`${arg} requires a value`);
        }
        defaults.inputDir = path.resolve(process.cwd(), value);
        idx += 1;
        break;
      }
      case '--batch': {
        const value = args[idx + 1];
        if (!value) {
          throw new Error(`${arg} requires a value`);
        }
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid batch size: ${value}`);
        }
        defaults.batchSize = parsed;
        idx += 1;
        break;
      }
      case '--dry-run': {
        defaults.dryRun = true;
        break;
      }
      case '--help':
      case '-h': {
        printUsage();
        process.exit(0);
      }
      default: {
        console.warn(`Unknown argument "${arg}" – run with --help for usage.`);
      }
    }
  }

  return defaults;
}

function printUsage(): void {
  console.log('Import Lovdata JSONL payloads into Supabase Postgres tables.');
  console.log('Usage: npm run import-lovdata -- [--dir <path>] [--batch <size>] [--dry-run]');
  console.log('Environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required).');
}

async function* iterateJsonl<T>(filePath: string): JsonlIterator<T> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as T;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

async function upsertArchives(
  supabase: ReturnType<typeof createClient>,
  archives: ArchivePayload[],
  dryRun: boolean
): Promise<void> {
  if (archives.length === 0) return;
  if (dryRun) {
    console.log(`[import] (dry-run) Would upsert ${archives.length} archives`);
    return;
  }

  const payload = archives.map(item => ({
    filename: item.filename,
    processed_at: item.processedAt,
    document_count: item.documentCount
  }));

  const response: PostgrestSingleResponse<unknown> = await supabase
    .from('lovdata_archives')
    .upsert(payload, { onConflict: 'filename' });

  if (response.error) {
    throw new Error(`Failed to upsert archives: ${response.error.message}`);
  }
  console.log(`[import] Upserted ${archives.length} archives`);
}

async function insertDocuments(
  supabase: ReturnType<typeof createClient>,
  documents: DocumentPayload[],
  dryRun: boolean
): Promise<void> {
  if (documents.length === 0) return;
  if (dryRun) {
    console.log(`[import] (dry-run) Would insert ${documents.length} documents`);
    return;
  }

  const payload = documents.map(item => ({
    archive_filename: item.archiveFilename,
    member: item.member,
    title: item.title,
    document_date: item.documentDate,
    content: item.content,
    relative_path: item.relativePath
  }));

  const response: PostgrestSingleResponse<unknown> = await supabase
    .from('lovdata_documents')
    .upsert(payload, { onConflict: 'archive_filename,member' });

  if (response.error) {
    throw new Error(`Failed to insert documents: ${response.error.message}`);
  }
  console.log(`[import] Upserted ${documents.length} documents`);
}

async function importArchives(filePath: string, supabase: ReturnType<typeof createClient>, dryRun: boolean) {
  try {
    await fs.access(filePath);
  } catch {
    console.warn(`[import] Archives file not found at ${filePath} – skipping`);
    return;
  }

  const archives: ArchivePayload[] = [];
  for await (const record of iterateJsonl<ArchivePayload>(filePath)) {
    archives.push(record);
  }

  if (archives.length === 0) {
    console.log('[import] No archives to import');
    return;
  }

  await upsertArchives(supabase, archives, dryRun);
}

async function importDocuments(
  filePath: string,
  supabase: ReturnType<typeof createClient>,
  batchSize: number,
  dryRun: boolean
) {
  try {
    await fs.access(filePath);
  } catch {
    console.warn(`[import] Documents file not found at ${filePath} – skipping`);
    return;
  }

  let batch: DocumentPayload[] = [];
  let total = 0;
  for await (const record of iterateJsonl<DocumentPayload>(filePath)) {
    batch.push(record);
    if (batch.length >= batchSize) {
      await insertDocuments(supabase, batch, dryRun);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await insertDocuments(supabase, batch, dryRun);
    total += batch.length;
  }

  console.log(`[import] Processed ${total} documents from ${filePath}`);
}

async function main() {
  const options = parseArgs();
  console.log('[import] Starting Lovdata import with options:', { ...options, serviceRoleKey: '<hidden>' });

  const archivesPath = path.join(options.inputDir, 'lovdata-archives.jsonl');
  const documentsPath = path.join(options.inputDir, 'lovdata-documents.jsonl');

  const supabase = createClient(options.supabaseUrl, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    await importArchives(archivesPath, supabase, options.dryRun);
    await importDocuments(documentsPath, supabase, options.batchSize, options.dryRun);
    console.log('[import] Import completed successfully.');
  } catch (error) {
    console.error('[import] Import failed:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('[import] Uncaught failure:', error);
  process.exit(1);
});


