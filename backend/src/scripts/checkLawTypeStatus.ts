#!/usr/bin/env tsx
import 'dotenv/config';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';

async function checkStatus() {
  const supabase = getSupabaseAdminClient();
  
  const { count: nullCount } = await supabase
    .from('lovdata_documents')
    .select('*', { count: 'exact', head: true })
    .is('law_type', null);
  
  const { count: totalCount } = await supabase
    .from('lovdata_documents')
    .select('*', { count: 'exact', head: true });
  
  const { count: nullChunkCount } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true })
    .is('law_type', null);
  
  const { count: totalChunkCount } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true });
  
  console.log('\n=== LAW_TYPE STATUS ===');
  console.log(`Documents with null law_type: ${nullCount ?? 0} / ${totalCount ?? 0} (${((nullCount ?? 0) / (totalCount ?? 1) * 100).toFixed(1)}%)`);
  console.log(`Documents with law_type set: ${(totalCount ?? 0) - (nullCount ?? 0)} (${(((totalCount ?? 0) - (nullCount ?? 0)) / (totalCount ?? 1) * 100).toFixed(1)}%)`);
  console.log(`\nChunks with null law_type: ${nullChunkCount ?? 0} / ${totalChunkCount ?? 0} (${((nullChunkCount ?? 0) / (totalChunkCount ?? 1) * 100).toFixed(1)}%)`);
  console.log(`Chunks with law_type set: ${(totalChunkCount ?? 0) - (nullChunkCount ?? 0)} (${(((totalChunkCount ?? 0) - (nullChunkCount ?? 0)) / (totalChunkCount ?? 1) * 100).toFixed(1)}%)`);
}

checkStatus().catch(console.error);

