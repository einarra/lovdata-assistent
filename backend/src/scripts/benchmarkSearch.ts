import { performance } from 'node:perf_hooks';
import { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';
import { searchLovdataPublicData } from '../services/lovdataSearch.js';

/**
 * Benchmark script for Supabase archive search performance.
 * Note: This benchmarks against production Supabase data, not local test data.
 */
async function runBenchmark() {
  console.log('Initializing Supabase archive store...');
  const store = new SupabaseArchiveStore();
  await store.init();

  const iterations = 100;
  const query = 'lovdata regelverk';

  console.log(`Running ${iterations} searches with query: "${query}"`);
  const started = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    await searchLovdataPublicData({
      store,
      query,
      page: 1,
      pageSize: 10
    });
  }
  
  const durationMs = performance.now() - started;

  console.log(`Ran ${iterations} archive searches in ${(durationMs / 1000).toFixed(2)}s (avg ${(durationMs / iterations).toFixed(2)} ms)`);
}

runBenchmark().catch(error => {
  console.error('Benchmark failed', error);
  process.exitCode = 1;
});

