#!/usr/bin/env tsx
import 'dotenv/config';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';

async function checkChunkEmbeddings() {
  const supabase = getSupabaseAdminClient();
  
  console.log('\n=== CHUNK EMBEDDING STATUS ===');
  
  // Get total stats
  const { count: totalWithEmbedding } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true })
    .not('embedding', 'is', null);
  
  const { count: totalChunks } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true });
  
  console.log(`Total chunks: ${totalChunks ?? 0}`);
  console.log(`Total chunks with embedding: ${totalWithEmbedding ?? 0}`);
  console.log(`Total chunks without embedding: ${(totalChunks ?? 0) - (totalWithEmbedding ?? 0)}`);
  console.log(`Percentage with embedding: ${totalChunks ? (((totalWithEmbedding ?? 0) / totalChunks) * 100).toFixed(1) : 0}%`);
}

checkChunkEmbeddings().catch(console.error);

