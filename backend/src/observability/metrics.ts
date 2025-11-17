import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

const register = new Registry();

collectDefaultMetrics({
  register,
  prefix: 'lovdata_'
});

const traceDurationHistogram = new Histogram({
  name: 'lovdata_trace_duration_seconds',
  help: 'Duration of traced operations in seconds',
  labelNames: ['name', 'run_type', 'status'],
  registers: [register],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20]
});

const traceErrorCounter = new Counter({
  name: 'lovdata_trace_errors_total',
  help: 'Total number of trace executions that resulted in errors',
  labelNames: ['name', 'run_type'],
  registers: [register]
});

type TraceObservation = {
  name: string;
  runType: string;
  status: 'success' | 'error';
  durationMs: number;
};

export function recordTraceObservation(observation: TraceObservation) {
  const { name, runType, status, durationMs } = observation;
  const durationSeconds = durationMs / 1000;
  traceDurationHistogram.observe({ name, run_type: runType, status }, durationSeconds);
  if (status === 'error') {
    traceErrorCounter.inc({ name, run_type: runType });
  }
}

export { register };

