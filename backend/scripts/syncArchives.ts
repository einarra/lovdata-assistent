#!/usr/bin/env tsx
/**
 * CLI script to manually sync archives from lovdata-api to Supabase.
 * 
 * This script checks for new archives and processes them, updating Supabase
 * with any new data found.
 * 
 * Usage:
 *   npm run sync-archives
 *   npm run sync-archives -- --skip-storage
 */

import 'dotenv/config';
import { logger } from '../src/logger.js';
import { getServices } from '../src/services/index.js';
import { SupabaseArchiveStore } from '../src/storage/supabaseArchiveStore.js';
import { syncArchives } from '../src/services/supabaseArchiveIngestor.js';

interface SyncOptions {
  skipStorageUpload: boolean;
}

function parseArgs(): SyncOptions {
  const options: SyncOptions = {
    skipStorageUpload: false
  };

  const args = process.argv.slice(2);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    switch (arg) {
      case '--skip-storage':
      case '--skip-storage-upload': {
        options.skipStorageUpload = true;
        break;
      }
      case '--help':
      case '-h': {
        console.log('Sync archives from lovdata-api to Supabase');
        console.log('');
        console.log('Usage:');
        console.log('  npm run sync-archives');
        console.log('  npm run sync-archives -- --skip-storage');
        console.log('');
        console.log('Options:');
        console.log('  --skip-storage, --skip-storage-upload    Skip uploading archive files to Supabase Storage');
        console.log('  --help, -h                              Show this help message');
        console.log('');
        console.log('Description:');
        console.log('  Checks lovdata-api for available archives and processes any new ones.');
        console.log('  Archives that are already in Supabase are skipped.');
        console.log('  Document content is saved to Supabase Postgres.');
        console.log('  Archive files can optionally be uploaded to Supabase Storage.');
        process.exit(0);
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}. Use --help for usage information.`);
      }
    }
  }

  return options;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();

    logger.info('Starting manual archive sync');

    // Initialize Supabase archive store
    const archiveStore = new SupabaseArchiveStore({ logger });
    await archiveStore.init();

    // Get services
    const services = getServices();
    if (!services.lovdata) {
      throw new Error('Lovdata client is not available');
    }

    // Run sync
    logger.info('Checking for new archives...');
    const result = await syncArchives(services.lovdata, archiveStore, {
      logger,
      skipStorageUpload: options.skipStorageUpload
    });

    // Print results
    console.log('\n' + '='.repeat(80));
    console.log('ARCHIVE SYNC RESULTS');
    console.log('='.repeat(80) + '\n');

    console.log(`Checked:     ${result.checked} archives`);
    console.log(`Processed:   ${result.processed} new archives`);
    console.log(`Skipped:     ${result.skipped} already processed`);
    console.log(`Errors:      ${result.errors.length}`);

    if (result.processed > 0) {
      console.log('\n✅ Successfully processed new archives!');
    }

    if (result.skipped > 0) {
      console.log(`\n⏭️  Skipped ${result.skipped} archive(s) that were already processed`);
    }

    if (result.errors.length > 0) {
      console.log('\n❌ Errors occurred:');
      for (const error of result.errors) {
        console.log(`   - ${error.filename}: ${error.error}`);
      }
      process.exitCode = 1;
    } else if (result.processed === 0 && result.checked > 0) {
      console.log('\n✅ All archives are up to date!');
    }

    console.log('\n' + '='.repeat(80) + '\n');

    if (options.skipStorageUpload) {
      console.log('ℹ️  Note: Archive files were not uploaded to Supabase Storage.');
      console.log('   To upload archive files, run: npm run upload-lovdata-storage\n');
    } else {
      console.log('ℹ️  Note: Archive file upload to Storage is not yet implemented.');
      console.log('   To upload archive files, run: npm run upload-lovdata-storage\n');
    }
  } catch (error) {
    logger.error({ err: error }, 'Archive sync failed');
    console.error('\n❌ Archive sync failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main().catch(error => {
  logger.error({ err: error }, 'Unhandled error in sync script');
  process.exit(1);
});

