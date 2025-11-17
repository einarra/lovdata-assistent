#!/usr/bin/env tsx
/**
 * Verification script to check that Supabase has all data before deleting local data directory.
 * 
 * This script verifies:
 * 1. Archive records match between SQLite and Supabase
 * 2. Document counts match between SQLite and Supabase
 * 3. Archive files exist in Supabase Storage
 * 4. Sample document content matches
 * 
 * Usage:
 *   npm run verify-supabase-migration
 *   npm run verify-supabase-migration -- --db path/to/lovdata.db
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../src/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VerificationOptions {
  dbPath: string;
  verbose: boolean;
}

interface VerificationResult {
  success: boolean;
  archives: {
    sqliteCount: number;
    supabaseCount: number;
    match: boolean;
    details: Array<{
      filename: string;
      sqliteDocs: number;
      supabaseDocs: number;
      match: boolean;
    }>;
  };
  documents: {
    sqliteTotal: number;
    supabaseTotal: number;
    match: boolean;
  };
  storage: {
    checked: number;
    found: number;
    missing: string[];
  };
  sampleDocuments: {
    checked: number;
    matched: number;
    mismatched: Array<{
      filename: string;
      member: string;
      reason: string;
    }>;
  };
  errors: string[];
}

async function verifySupabaseMigration(options: VerificationOptions): Promise<VerificationResult> {
  const result: VerificationResult = {
    success: false,
    archives: {
      sqliteCount: 0,
      supabaseCount: 0,
      match: false,
      details: []
    },
    documents: {
      sqliteTotal: 0,
      supabaseTotal: 0,
      match: false
    },
    storage: {
      checked: 0,
      found: 0,
      missing: []
    },
    sampleDocuments: {
      checked: 0,
      matched: 0,
      mismatched: []
    },
    errors: []
  };

  // Initialize Supabase client
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    result.errors.push('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
    return result;
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  // Open SQLite database
  let db: Database.Database | null = null;
  try {
    db = new Database(options.dbPath, { readonly: true });
  } catch (error) {
    result.errors.push(`Failed to open SQLite database: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  try {
    // 1. Verify archive records
    logger.info('Verifying archive records...');
    const sqliteArchives = db
      .prepare('SELECT filename, document_count FROM archives ORDER BY filename')
      .all() as Array<{ filename: string; document_count: number }>;

    result.archives.sqliteCount = sqliteArchives.length;

    const { data: supabaseArchives, error: archivesError } = await supabase
      .from('lovdata_archives')
      .select('filename, document_count')
      .order('filename');

    if (archivesError) {
      result.errors.push(`Failed to fetch Supabase archives: ${archivesError.message}`);
    } else {
      result.archives.supabaseCount = supabaseArchives?.length ?? 0;
      result.archives.match = result.archives.sqliteCount === result.archives.supabaseCount;

      // Compare individual archives
      const supabaseMap = new Map(
        (supabaseArchives ?? []).map(a => [a.filename, a.document_count])
      );

      for (const sqliteArchive of sqliteArchives) {
        const supabaseDocs = supabaseMap.get(sqliteArchive.filename) ?? 0;
        const match = sqliteArchive.document_count === supabaseDocs;
        
        result.archives.details.push({
          filename: sqliteArchive.filename,
          sqliteDocs: sqliteArchive.document_count,
          supabaseDocs,
          match
        });

        if (!match) {
          result.errors.push(
            `Archive ${sqliteArchive.filename}: SQLite has ${sqliteArchive.document_count} docs, Supabase has ${supabaseDocs}`
          );
        }
      }
    }

    // 2. Verify total document count
    logger.info('Verifying document counts...');
    const sqliteTotal = db
      .prepare('SELECT COUNT(*) as count FROM documents')
      .get() as { count: number };

    result.documents.sqliteTotal = sqliteTotal.count;

    const { count: supabaseTotal, error: countError } = await supabase
      .from('lovdata_documents')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      result.errors.push(`Failed to count Supabase documents: ${countError.message}`);
    } else {
      result.documents.supabaseTotal = supabaseTotal ?? 0;
      result.documents.match = result.documents.sqliteTotal === result.documents.supabaseTotal;

      if (!result.documents.match) {
        result.errors.push(
          `Document count mismatch: SQLite has ${result.documents.sqliteTotal}, Supabase has ${result.documents.supabaseTotal}`
        );
      }
    }

    // 3. Verify archive files in storage
    logger.info('Verifying archive files in Supabase Storage...');
    const archiveFilenames = sqliteArchives.map(a => a.filename);
    
    for (const filename of archiveFilenames) {
      result.storage.checked++;
      const { data, error } = await supabase.storage
        .from('lovdata-archives')
        .list(filename, { limit: 1 });

      if (error) {
        result.storage.missing.push(filename);
        result.errors.push(`Archive file ${filename} not found in storage: ${error.message}`);
      } else if (data && data.length > 0) {
        result.storage.found++;
      } else {
        result.storage.missing.push(filename);
        result.errors.push(`Archive file ${filename} not found in storage (empty listing)`);
      }
    }

    // 4. Sample document verification (check first 10 documents)
    logger.info('Verifying sample documents...');
    const sampleDocs = db
      .prepare(`
        SELECT archive_filename, member, content, title, date 
        FROM documents 
        ORDER BY id 
        LIMIT 10
      `)
      .all() as Array<{
        archive_filename: string;
        member: string;
        content: string;
        title: string | null;
        date: string | null;
      }>;

    for (const sqliteDoc of sampleDocs) {
      result.sampleDocuments.checked++;

      const { data: supabaseDoc, error } = await supabase
        .from('lovdata_documents')
        .select('content, title, document_date')
        .eq('archive_filename', sqliteDoc.archive_filename)
        .eq('member', sqliteDoc.member)
        .maybeSingle();

      if (error) {
        result.sampleDocuments.mismatched.push({
          filename: sqliteDoc.archive_filename,
          member: sqliteDoc.member,
          reason: `Error fetching: ${error.message}`
        });
        continue;
      }

      if (!supabaseDoc) {
        result.sampleDocuments.mismatched.push({
          filename: sqliteDoc.archive_filename,
          member: sqliteDoc.member,
          reason: 'Document not found in Supabase'
        });
        continue;
      }

      // Compare content (normalize whitespace)
      const sqliteContent = sqliteDoc.content.trim().replace(/\s+/g, ' ');
      const supabaseContent = (supabaseDoc.content ?? '').trim().replace(/\s+/g, ' ');

      if (sqliteContent !== supabaseContent) {
        result.sampleDocuments.mismatched.push({
          filename: sqliteDoc.archive_filename,
          member: sqliteDoc.member,
          reason: 'Content mismatch'
        });
        continue;
      }

      // Compare title and date (allow for null differences)
      const titleMatch = (sqliteDoc.title ?? null) === (supabaseDoc.title ?? null);
      const dateMatch = (sqliteDoc.date ?? null) === (supabaseDoc.document_date ?? null);

      if (!titleMatch || !dateMatch) {
        result.sampleDocuments.mismatched.push({
          filename: sqliteDoc.archive_filename,
          member: sqliteDoc.member,
          reason: `Metadata mismatch (title: ${titleMatch}, date: ${dateMatch})`
        });
        continue;
      }

      result.sampleDocuments.matched++;
    }

    // Determine overall success
    result.success =
      result.archives.match &&
      result.documents.match &&
      result.storage.missing.length === 0 &&
      result.sampleDocuments.mismatched.length === 0 &&
      result.errors.length === 0;

  } finally {
    db?.close();
  }

  return result;
}

function printReport(result: VerificationResult, verbose: boolean): void {
  console.log('\n' + '='.repeat(80));
  console.log('SUPABASE MIGRATION VERIFICATION REPORT');
  console.log('='.repeat(80) + '\n');

  // Overall status
  if (result.success) {
    console.log('✅ VERIFICATION PASSED - Safe to delete local data directory\n');
  } else {
    console.log('❌ VERIFICATION FAILED - Do NOT delete local data directory\n');
  }

  // Archive verification
  console.log('📦 Archive Records:');
  console.log(`   SQLite:  ${result.archives.sqliteCount} archives`);
  console.log(`   Supabase: ${result.archives.supabaseCount} archives`);
  if (result.archives.match) {
    console.log('   ✅ Counts match');
  } else {
    console.log('   ❌ Counts do NOT match');
  }

  if (verbose && result.archives.details.length > 0) {
    console.log('\n   Archive Details:');
    for (const detail of result.archives.details) {
      const icon = detail.match ? '✅' : '❌';
      console.log(`   ${icon} ${detail.filename}:`);
      console.log(`      SQLite: ${detail.sqliteDocs} docs, Supabase: ${detail.supabaseDocs} docs`);
    }
  }

  // Document count verification
  console.log('\n📄 Document Counts:');
  console.log(`   SQLite:  ${result.documents.sqliteTotal.toLocaleString()} documents`);
  console.log(`   Supabase: ${result.documents.supabaseTotal.toLocaleString()} documents`);
  if (result.documents.match) {
    console.log('   ✅ Counts match');
  } else {
    console.log('   ❌ Counts do NOT match');
    const diff = Math.abs(result.documents.sqliteTotal - result.documents.supabaseTotal);
    console.log(`   ⚠️  Difference: ${diff.toLocaleString()} documents`);
  }

  // Storage verification
  console.log('\n💾 Archive Files in Storage:');
  console.log(`   Checked: ${result.storage.checked}`);
  console.log(`   Found: ${result.storage.found}`);
  console.log(`   Missing: ${result.storage.missing.length}`);
  if (result.storage.missing.length > 0) {
    console.log('   ❌ Missing files:');
    for (const filename of result.storage.missing) {
      console.log(`      - ${filename}`);
    }
  } else {
    console.log('   ✅ All archive files found in storage');
  }

  // Sample document verification
  console.log('\n🔍 Sample Document Verification:');
  console.log(`   Checked: ${result.sampleDocuments.checked} documents`);
  console.log(`   Matched: ${result.sampleDocuments.matched}`);
  console.log(`   Mismatched: ${result.sampleDocuments.mismatched.length}`);
  if (result.sampleDocuments.mismatched.length > 0) {
    console.log('   ❌ Mismatched documents:');
    for (const mismatch of result.sampleDocuments.mismatched) {
      console.log(`      - ${mismatch.filename}/${mismatch.member}: ${mismatch.reason}`);
    }
  } else {
    console.log('   ✅ All sample documents match');
  }

  // Errors
  if (result.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    for (const error of result.errors) {
      console.log(`   - ${error}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  
  if (result.success) {
    console.log('\n✅ VERIFICATION COMPLETE - All checks passed!');
    console.log('   It is SAFE to delete the local data directory.');
    console.log('   Recommended: Create a backup first:');
    console.log('   tar -czf backend-data-backup-$(date +%Y%m%d).tar.gz backend/data/');
  } else {
    console.log('\n❌ VERIFICATION FAILED - Issues found!');
    console.log('   Do NOT delete the local data directory until issues are resolved.');
    console.log('   Review the errors above and fix any migration issues.');
  }
  console.log('='.repeat(80) + '\n');
}

function parseArgs(): VerificationOptions {
  const cwd = process.cwd();
  const defaults: VerificationOptions = {
    dbPath: path.resolve(cwd, 'data', 'lovdata.db'),
    verbose: false
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
      case '--verbose':
      case '-v': {
        defaults.verbose = true;
        break;
      }
      case '--help':
      case '-h': {
        console.log('Verify Supabase migration completeness');
        console.log('');
        console.log('Usage:');
        console.log('  npm run verify-supabase-migration');
        console.log('  npm run verify-supabase-migration -- --db path/to/lovdata.db');
        console.log('  npm run verify-supabase-migration -- --verbose');
        console.log('');
        console.log('Options:');
        console.log('  --db, --db-path    Path to SQLite database (default: data/lovdata.db)');
        console.log('  --verbose, -v      Show detailed archive information');
        console.log('  --help, -h         Show this help message');
        process.exit(0);
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return defaults;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();
    
    logger.info({ dbPath: options.dbPath }, 'Starting Supabase migration verification');

    const result = await verifySupabaseMigration(options);
    printReport(result, options.verbose);

    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    logger.error({ err: error }, 'Verification failed');
    console.error('\n❌ Verification script failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main().catch(error => {
  logger.error({ err: error }, 'Unhandled error in verification script');
  process.exit(1);
});

