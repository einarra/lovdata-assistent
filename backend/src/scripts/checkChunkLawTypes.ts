#!/usr/bin/env tsx
/**
 * Script to check if chunks have law_type set in the database
 */

import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { logger } from '../logger.js';

async function checkChunkLawTypes() {
  const supabase = getSupabaseAdminClient();
  
  logger.info('Checking law_type distribution in chunks...');
  
  // Check chunks law_type distribution
  const { data: chunkLawTypes, error: chunkError } = await supabase
    .from('document_chunks')
    .select('law_type')
    .limit(10000); // Sample up to 10k chunks
  
  if (chunkError) {
    logger.error({ err: chunkError }, 'Failed to query chunks');
    return;
  }
  
  const chunkCounts = {
    total: chunkLawTypes?.length ?? 0,
    withLawType: 0,
    nullLawType: 0,
    lawTypes: {} as Record<string, number>
  };
  
  if (chunkLawTypes) {
    for (const chunk of chunkLawTypes) {
      if (chunk.law_type === null || chunk.law_type === undefined) {
        chunkCounts.nullLawType++;
      } else {
        chunkCounts.withLawType++;
        const type = String(chunk.law_type);
        chunkCounts.lawTypes[type] = (chunkCounts.lawTypes[type] || 0) + 1;
      }
    }
  }
  
  logger.info(chunkCounts, 'Chunk law_type distribution (sample)');
  
  // Check documents law_type distribution for comparison
  logger.info('Checking law_type distribution in documents...');
  
  const { data: docLawTypes, error: docError } = await supabase
    .from('lovdata_documents')
    .select('law_type')
    .limit(10000);
  
  if (docError) {
    logger.error({ err: docError }, 'Failed to query documents');
    return;
  }
  
  const docCounts = {
    total: docLawTypes?.length ?? 0,
    withLawType: 0,
    nullLawType: 0,
    lawTypes: {} as Record<string, number>
  };
  
  if (docLawTypes) {
    for (const doc of docLawTypes) {
      if (doc.law_type === null || doc.law_type === undefined) {
        docCounts.nullLawType++;
      } else {
        docCounts.withLawType++;
        const type = String(doc.law_type);
        docCounts.lawTypes[type] = (docCounts.lawTypes[type] || 0) + 1;
      }
    }
  }
  
  logger.info(docCounts, 'Document law_type distribution (sample)');
  
  // Check if chunks with law_type='Lov' exist
  logger.info('Checking for chunks with law_type = Lov...');
  
  const { count: lovChunkCount, error: lovChunkError } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('law_type', 'Lov');
  
  if (lovChunkError) {
    logger.error({ err: lovChunkError }, 'Failed to count Lov chunks');
  } else {
    logger.info({ count: lovChunkCount }, 'Total chunks with law_type = Lov');
  }
  
  // Check if chunks with law_type='Forskrift' exist
  logger.info('Checking for chunks with law_type = Forskrift...');
  
  const { count: forskriftChunkCount, error: forskriftChunkError } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('law_type', 'Forskrift');
  
  if (forskriftChunkError) {
    logger.error({ err: forskriftChunkError }, 'Failed to count Forskrift chunks');
  } else {
    logger.info({ count: forskriftChunkCount }, 'Total chunks with law_type = Forskrift');
  }
  
  // Check documents with law_type='Lov' for comparison
  logger.info('Checking for documents with law_type = Lov...');
  
  const { count: lovDocCount, error: lovDocError } = await supabase
    .from('lovdata_documents')
    .select('*', { count: 'exact', head: true })
    .eq('law_type', 'Lov');
  
  if (lovDocError) {
    logger.error({ err: lovDocError }, 'Failed to count Lov documents');
  } else {
    logger.info({ count: lovDocCount }, 'Total documents with law_type = Lov');
  }
  
  // Check a sample of chunks to see their structure
  logger.info('Checking sample of chunks...');
  
  const { data: sampleChunks, error: sampleError } = await supabase
    .from('document_chunks')
    .select('id, document_id, law_type, archive_filename, member')
    .limit(10);
  
  if (sampleError) {
    logger.error({ err: sampleError }, 'Failed to get sample chunks');
  } else {
    logger.info({ sample: sampleChunks }, 'Sample chunks');
  }
  
  console.log('\n=== SUMMARY ===');
  console.log(`Chunks sampled: ${chunkCounts.total}`);
  console.log(`Chunks with law_type: ${chunkCounts.withLawType} (${((chunkCounts.withLawType / chunkCounts.total) * 100).toFixed(1)}%)`);
  console.log(`Chunks without law_type (null): ${chunkCounts.nullLawType} (${((chunkCounts.nullLawType / chunkCounts.total) * 100).toFixed(1)}%)`);
  console.log(`Law type distribution in chunks:`, chunkCounts.lawTypes);
  console.log(`\nDocuments sampled: ${docCounts.total}`);
  console.log(`Documents with law_type: ${docCounts.withLawType} (${((docCounts.withLawType / docCounts.total) * 100).toFixed(1)}%)`);
  console.log(`Documents without law_type (null): ${docCounts.nullLawType} (${((docCounts.nullLawType / docCounts.total) * 100).toFixed(1)}%)`);
  console.log(`Law type distribution in documents:`, docCounts.lawTypes);
  console.log(`\nTotal chunks with law_type='Lov': ${lovChunkCount ?? 0}`);
  console.log(`Total chunks with law_type='Forskrift': ${forskriftChunkCount ?? 0}`);
  console.log(`Total documents with law_type='Lov': ${lovDocCount ?? 0}`);
}

checkChunkLawTypes()
  .then(() => {
    logger.info('Check completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ err: error }, 'Check failed');
    process.exit(1);
  });

