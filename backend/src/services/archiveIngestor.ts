import fs from 'node:fs/promises';
import type { Logger } from 'pino';
import { LovdataClient } from './lovdataClient.js';
import { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';

export type ArchiveBootstrapOptions = {
  dataDir?: string;
  logger?: Logger;
};

/**
 * @deprecated This function is no longer used. Use SupabaseArchiveStore directly.
 * Archive ingestion is now handled via migration scripts (export-lovdata, import-lovdata).
 */
export async function bootstrapArchiveStore(
  _client: LovdataClient,
  _options: ArchiveBootstrapOptions = {}
): Promise<SupabaseArchiveStore> {
  throw new Error(
    'bootstrapArchiveStore is deprecated. Use SupabaseArchiveStore directly. ' +
    'For data migration, use: npm run export-lovdata && npm run import-lovdata'
  );
}

export async function clearDataDirectory(dataDir: string): Promise<void> {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
}

