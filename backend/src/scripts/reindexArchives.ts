import 'dotenv/config';
import { logger } from '../logger.js';
import { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';

/**
 * @deprecated This script is no longer needed as we use Supabase for storage.
 * To reindex archives, use the migration scripts:
 * - npm run export-lovdata (if you have local SQLite data)
 * - npm run import-lovdata (to import to Supabase)
 * 
 * The SupabaseArchiveStore automatically reads from Supabase, so no local reindexing is needed.
 */
async function main() {
  logger.warn('reindex script is deprecated - Supabase is used for storage');
  logger.info('Initializing Supabase archive store to verify connection...');
  
  const archiveStore = new SupabaseArchiveStore({ logger });
  await archiveStore.init();
  
  logger.info('Supabase archive store initialized successfully');
  logger.info('To update archives, use: npm run export-lovdata && npm run import-lovdata');
}

main().catch(error => {
  logger.error({ err: error }, 'Failed to initialize Supabase archive store');
  process.exitCode = 1;
});

