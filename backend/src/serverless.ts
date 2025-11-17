// Serverless-specific initialization for Vercel
// This initializes services without starting an HTTP server

import { setArchiveStore } from './services/index.js';
import { SupabaseArchiveStore } from './storage/supabaseArchiveStore.js';
import { logger } from './logger.js';
import { setReadyState } from './state/runtimeState.js';
import { env } from './config/env.js';

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initializeServerless(): Promise<void> {
  if (initialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      logger.info('Initializing serverless backend...');
      setReadyState(false);

      // Initialize Supabase archive storage
      logger.info('Initializing Supabase archive storage');
      const archiveStore = new SupabaseArchiveStore({ logger });
      await archiveStore.init();
      setArchiveStore(archiveStore);

      // Optionally sync archives on startup (only if enabled)
      if (env.SYNC_ARCHIVES_ON_STARTUP) {
        logger.info('SYNC_ARCHIVES_ON_STARTUP enabled, checking for new archives...');
        const { getServices } = await import('./services/index.js');
        const { syncArchives } = await import('./services/supabaseArchiveIngestor.js');
        const services = getServices();
        
        if (services.lovdata) {
          try {
            const result = await syncArchives(services.lovdata, archiveStore, { logger });
            logger.info(
              {
                checked: result.checked,
                processed: result.processed,
                skipped: result.skipped,
                errors: result.errors.length
              },
              'Archive sync completed'
            );
            if (result.errors.length > 0) {
              logger.warn({ errors: result.errors }, 'Some archives failed to sync');
            }
          } catch (error) {
            logger.error({ err: error }, 'Archive sync failed, continuing startup');
            // Don't fail startup if sync fails
          }
        } else {
          logger.warn('Lovdata client not available, skipping archive sync');
        }
      }

      setReadyState(true);
      logger.info('Serverless backend initialized successfully');
      initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize serverless backend');
      // Set ready state anyway - some endpoints may still work
      setReadyState(true);
      initialized = true;
      throw error;
    }
  })();

  return initPromise;
}

