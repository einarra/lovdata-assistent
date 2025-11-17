import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { logger } from '../logger.js';
import { recordTraceObservation } from './metrics.js';

type TraceParams<T> = {
  name: string;
  runType: 'chain' | 'tool' | 'llm' | 'retrieval';
  inputs: Record<string, unknown>;
  tags?: string[];
  getOutputs?: (result: T) => Record<string, unknown> | undefined;
};

type TraceContext = {
  runId: string;
};

type TraceResult<T> = {
  result: T;
  runId: string;
};

export async function withTrace<T>(params: TraceParams<T>, fn: (context: TraceContext) => Promise<T>): Promise<TraceResult<T>> {
  const runId = randomUUID();
  const started = performance.now();

  logger.debug(
    {
      trace: {
        runId,
        name: params.name,
        runType: params.runType,
        inputs: params.inputs,
        tags: params.tags
      }
    },
    'Trace started'
  );

  try {
    const result = await fn({ runId });
    const outputs = params.getOutputs?.(result);
    const durationMs = performance.now() - started;

    logger.debug(
      {
        trace: {
          runId,
          name: params.name,
          runType: params.runType,
          durationMs,
          tags: params.tags,
          outputs
        }
      },
      'Trace completed'
    );

    recordTraceObservation({
      name: params.name,
      runType: params.runType,
      status: 'success',
      durationMs
    });

    return { result, runId };
  } catch (error) {
    const durationMs = performance.now() - started;

    logger.error(
      {
        err: error,
        trace: {
          runId,
          name: params.name,
          runType: params.runType,
          durationMs,
          tags: params.tags
        }
      },
      'Trace failed'
    );

    recordTraceObservation({
      name: params.name,
      runType: params.runType,
      status: 'error',
      durationMs
    });

    throw error;
  }
}
