import { createApp } from './http/app.js';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { getServices, setArchiveStore } from './services/index.js';
import { SupabaseArchiveStore } from './storage/supabaseArchiveStore.js';
import { syncArchives } from './services/supabaseArchiveIngestor.js';
import { setReadyState } from './state/runtimeState.js';
import { Timer, timeOperation } from './utils/timing.js';

async function start() {
  // Immediate test log to verify logger is working
  // Use console.log first to ensure we see something, then logger
  console.log('🚀 Server starting...');
  console.log(`Environment: ${env.NODE_ENV}, Log Level: ${env.LOG_LEVEL}, Log File: ${env.LOG_FILE || 'none'}`);
  
  // Give logger a moment to initialize (pino-pretty transport is async)
  await new Promise(resolve => setTimeout(resolve, 100));
  
  logger.info('🚀 Server starting...');
  logger.info({ env: env.NODE_ENV, logLevel: env.LOG_LEVEL, logFile: env.LOG_FILE }, 'Logger configuration');
  
  // DIAGNOSTIC: Check OPENAI_API_KEY status in detail
  logger.error({
    envOpenaiApiKey: !!env.OPENAI_API_KEY,
    envOpenaiApiKeyLength: env.OPENAI_API_KEY?.length || 0,
    processEnvOpenaiApiKey: !!process.env.OPENAI_API_KEY,
    processEnvOpenaiApiKeyLength: process.env.OPENAI_API_KEY?.length || 0,
    inEnvObject: 'OPENAI_API_KEY' in env,
    nodeEnv: env.NODE_ENV,
    cwd: process.cwd()
  }, 'DIAGNOSTIC: OPENAI_API_KEY status check');
  
  // Verify OPENAI_API_KEY is loaded
  if (!env.OPENAI_API_KEY) {
    logger.error({
      openaiApiKeyInEnv: !!process.env.OPENAI_API_KEY,
      openaiApiKeyLength: process.env.OPENAI_API_KEY?.length || 0,
      nodeEnv: env.NODE_ENV
    }, 'CRITICAL: OPENAI_API_KEY is missing from env configuration');
    logger.error('OpenAI agent will not be available. Check that OPENAI_API_KEY is set in your .env file.');
  } else {
    logger.info({ openaiApiKeyLength: env.OPENAI_API_KEY.length }, 'OPENAI_API_KEY loaded successfully');
  }
  
  const startupTimer = new Timer('startup', logger);
  setReadyState(false);
  try {
    logger.info('Initializing Supabase archive storage');
    const initTimer = new Timer('archive_store_init', logger);
    const archiveStore = new SupabaseArchiveStore({ logger });
    await archiveStore.init();
    initTimer.end();
    setArchiveStore(archiveStore);
    
    // Optionally sync archives on startup
    if (env.SYNC_ARCHIVES_ON_STARTUP) {
      logger.info('SYNC_ARCHIVES_ON_STARTUP enabled, checking for new archives...');
      const services = getServices();
      if (services.lovdata) {
        try {
          const result = await timeOperation(
            'archive_sync',
            () => syncArchives(services.lovdata!, archiveStore, { logger }),
            logger
          );
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
    startupTimer.checkpoint('services_ready');
  } catch (error) {
    startupTimer.end({ success: false });
    logger.error({ err: error }, 'Failed to bootstrap archive store');
    logger.error('Exiting due to critical service failure');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    startupTimer.end({ port: env.PORT });
    logger.info({ port: env.PORT }, 'Backend listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    setReadyState(false);
    server.close(err => {
      if (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(error => {
  logger.error({ err: error }, 'Failed to start backend');
  process.exit(1);
});
