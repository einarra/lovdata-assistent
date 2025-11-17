import 'dotenv/config';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

type ExportOptions = {
  dbPath: string;
  outputDir: string;
  batchSize: number;
};

type ArchiveRow = {
  filename: string;
  processed_at: string;
  document_count: number;
};

type DocumentRow = {
  id: number;
  archive_filename: string;
  member: string;
  title: string | null;
  date: string | null;
  content: string;
  relative_path: string;
};

function parseArgs(): ExportOptions {
  const cwd = process.cwd();
  const defaults: ExportOptions = {
    dbPath: path.resolve(cwd, 'data/lovdata.db'),
    outputDir: path.resolve(cwd, 'tmp', 'migration'),
    batchSize: 1000
  };

  const args = process.argv.slice(2);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    switch (arg) {
      case '--db':
      case '--db-path': {
        const value = args[idx + 1];
        if (!value) {
          throw new Error(`${arg} requires a value`);
        }
        defaults.dbPath = path.resolve(cwd, value);
        idx += 1;
        break;
      }
      case '--out':
      case '--output': {
        const value = args[idx + 1];
        if (!value) {
          throw new Error(`${arg} requires a value`);
        }
        defaults.outputDir = path.resolve(cwd, value);
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
  console.log('Export Lovdata SQLite content to JSONL for Supabase migration.');
  console.log('Usage: npm run export-lovdata -- [--db <path>] [--out <dir>] [--batch <size>]');
  console.log('');
  console.log('Defaults:');
  console.log('  --db    data/lovdata.db');
  console.log('  --out   tmp/migration');
  console.log('  --batch 1000');
}

async function writeJsonLines<T extends Record<string, unknown>>(filePath: string, rows: T[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });

  for (const row of rows) {
    stream.write(`${JSON.stringify(row)}\n`);
  }

  stream.end();
  await once(stream, 'finish');
}

async function exportArchives(db: Database.Database, options: ExportOptions): Promise<number> {
  const stmt = db.prepare<[], ArchiveRow>('SELECT filename, processed_at, document_count FROM archives ORDER BY filename');
  const rows = stmt.all();
  const filePath = path.join(options.outputDir, 'lovdata-archives.jsonl');
  await writeJsonLines(
    filePath,
    rows.map(row => ({
      filename: row.filename,
      processedAt: row.processed_at,
      documentCount: row.document_count
    }))
  );
  console.log(`[export] Wrote ${rows.length} archive rows to ${filePath}`);
  return rows.length;
}

async function exportDocuments(db: Database.Database, options: ExportOptions): Promise<number> {
  const stmt = db.prepare<[number, number], DocumentRow>(
    `SELECT id, archive_filename, member, title, date, content, relative_path
     FROM documents
     ORDER BY id
     LIMIT ? OFFSET ?`
  );
  const totalStmt = db.prepare<[], { total: number }>('SELECT COUNT(*) as total FROM documents');
  const total = totalStmt.get()?.total ?? 0;
  if (total === 0) {
    console.log('[export] No documents found in database.');
    return 0;
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  const filePath = path.join(options.outputDir, 'lovdata-documents.jsonl');
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });

  let exported = 0;
  let offset = 0;
  while (offset < total) {
    const rows = stmt.all(options.batchSize, offset);
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const payload = {
        id: row.id,
        archiveFilename: row.archive_filename,
        member: row.member,
        title: row.title,
        documentDate: row.date,
        content: row.content,
        relativePath: row.relative_path
      };
      stream.write(`${JSON.stringify(payload)}\n`);
    }

    exported += rows.length;
    offset += rows.length;

    if (exported % (options.batchSize * 5) === 0 || exported === total) {
      console.log(`[export] Exported ${exported}/${total} documents...`);
    }
  }

  stream.end();
  await once(stream, 'finish');
  console.log(`[export] Wrote ${exported} documents to ${filePath}`);
  return exported;
}

async function exportSummary(options: ExportOptions, archives: number, documents: number): Promise<void> {
  const summary = {
    generatedAt: new Date().toISOString(),
    source: options.dbPath,
    archives,
    documents,
    batchSize: options.batchSize
  };
  const summaryPath = path.join(options.outputDir, 'lovdata-export.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`[export] Wrote summary to ${summaryPath}`);
}

async function main() {
  const options = parseArgs();
  console.log('[export] Starting Lovdata export with options:', options);

  try {
    await fs.access(options.dbPath);
  } catch {
    console.error(`[export] SQLite database not found at ${options.dbPath}`);
    process.exit(1);
  }

  const db = new Database(options.dbPath, { readonly: true });

  try {
    const archiveCount = await exportArchives(db, options);
    const documentCount = await exportDocuments(db, options);
    await exportSummary(options, archiveCount, documentCount);
    console.log('[export] Export completed successfully.');
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error('[export] Export failed:', error);
  process.exit(1);
});


