import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';

/**
 * Utility for timing operations and logging execution time.
 * Helps identify performance bottlenecks in the application.
 */
export class Timer {
  private readonly startTime: number;
  private readonly operation: string;
  private readonly logger: Logger;
  private readonly metadata?: Record<string, unknown>;

  constructor(operation: string, logger: Logger, metadata?: Record<string, unknown>) {
    this.operation = operation;
    this.logger = logger;
    this.metadata = metadata;
    this.startTime = performance.now();
    this.logger.debug(
      {
        operation,
        timestamp: new Date().toISOString(),
        ...metadata
      },
      `[TIMING] Starting: ${operation}`
    );
  }

  /**
   * Logs the elapsed time and returns the duration in milliseconds.
   */
  end(additionalMetadata?: Record<string, unknown>): number {
    const duration = performance.now() - this.startTime;
    const durationMs = Math.round(duration);
    const durationSec = (duration / 1000).toFixed(2);

    this.logger.info(
      {
        operation: this.operation,
        durationMs,
        durationSec: `${durationSec}s`,
        timestamp: new Date().toISOString(),
        ...this.metadata,
        ...additionalMetadata
      },
      `[TIMING] Completed: ${this.operation} (${durationSec}s)`
    );

    return durationMs;
  }

  /**
   * Logs a checkpoint with elapsed time so far.
   */
  checkpoint(checkpointName: string, additionalMetadata?: Record<string, unknown>): void {
    const elapsed = performance.now() - this.startTime;
    const elapsedMs = Math.round(elapsed);
    const elapsedSec = (elapsed / 1000).toFixed(2);

    this.logger.debug(
      {
        operation: this.operation,
        checkpoint: checkpointName,
        elapsedMs,
        elapsedSec: `${elapsedSec}s`,
        timestamp: new Date().toISOString(),
        ...this.metadata,
        ...additionalMetadata
      },
      `[TIMING] Checkpoint: ${this.operation} -> ${checkpointName} (${elapsedSec}s)`
    );
  }

  /**
   * Returns the current elapsed time in milliseconds without logging.
   */
  getElapsed(): number {
    return Math.round(performance.now() - this.startTime);
  }
}

/**
 * Times an async operation and logs the result.
 */
export async function timeOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  logger: Logger,
  metadata?: Record<string, unknown>
): Promise<T> {
  const timer = new Timer(operation, logger, metadata);
  try {
    const result = await fn();
    timer.end({ success: true });
    return result;
  } catch (error) {
    timer.end({ success: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Times a synchronous operation and logs the result.
 */
export function timeSyncOperation<T>(
  operation: string,
  fn: () => T,
  logger: Logger,
  metadata?: Record<string, unknown>
): T {
  const timer = new Timer(operation, logger, metadata);
  try {
    const result = fn();
    timer.end({ success: true });
    return result;
  } catch (error) {
    timer.end({ success: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

