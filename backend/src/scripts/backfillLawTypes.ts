#!/usr/bin/env tsx
/**
 * Script to backfill law_type values for existing documents and chunks in the database.
 * This script reads document content and extracts law_type using the extractLawType function,
 * then updates both documents and chunks with the extracted values.
 */

import 'dotenv/config';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { logger } from '../logger.js';

// Copy the extraction functions from supabaseArchiveIngestor since they're not exported
// These should match the implementation in supabaseArchiveIngestor.ts

/**
 * Extract law type from document text and title
 */
function extractLawType(text: string, title: string | null): string | null {
  const searchText = (title ? title + ' ' : '') + text;
  const lowerText = searchText.toLowerCase();
  
  // Common law type patterns in Norwegian legal documents
  const lawTypePatterns = [
    { pattern: /\b(lov|act)\b/i, type: 'Lov' },
    { pattern: /\b(forskrift|regulation)\b/i, type: 'Forskrift' },
    { pattern: /\b(vedtak|decision)\b/i, type: 'Vedtak' },
    { pattern: /\b(cirkulær|circular)\b/i, type: 'Cirkulær' },
    { pattern: /\b(rundskriv|circular letter)\b/i, type: 'Rundskriv' },
    { pattern: /\b(instruks|instruction)\b/i, type: 'Instruks' },
    { pattern: /\b(reglement|regulations)\b/i, type: 'Reglement' },
    { pattern: /\b(vedlegg|annex|appendix)\b/i, type: 'Vedlegg' }
  ];
  
  // Check title first (more reliable)
  if (title) {
    for (const { pattern, type } of lawTypePatterns) {
      if (pattern.test(title)) {
        return type;
      }
    }
  }
  
  // Check content
  for (const { pattern, type } of lawTypePatterns) {
    if (pattern.test(lowerText)) {
      return type;
    }
  }
  
  // Check for specific law name patterns (e.g., "Folketrygdloven", "Arbeidsmiljøloven")
  const lawNamePattern = /\b([A-ZÆØÅ][a-zæøå]+loven?)\b/;
  const lawNameMatch = searchText.match(lawNamePattern);
  if (lawNameMatch) {
    return 'Lov';
  }
  
  return null;
}

/**
 * Extract year from document date or text
 */
function extractYear(text: string, date: string | null): number | null {
  if (date) {
    // Try to extract year from date string (format: YYYY-MM-DD or similar)
    const yearMatch = date.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      return parseInt(yearMatch[0], 10);
    }
  }
  
  // Try to find year in text
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    return parseInt(yearMatch[0], 10);
  }
  
  return null;
}

/**
 * Extract ministry from document text and title
 */
function extractMinistry(text: string, title: string | null): string | null {
  const searchText = (title ? title + ' ' : '') + text;
  const lowerText = searchText.toLowerCase();
  
  // Common Norwegian ministries
  const ministries = [
    { patterns: [/\b(arbeids-?\s*og\s*sosialdepartementet|asd|arbeidsdepartementet)\b/i], name: 'Arbeids- og sosialdepartementet' },
    { patterns: [/\b(barne-?\s*og\s*familiedepartementet|bfd|barnefamiliedepartementet)\b/i], name: 'Barne- og familiedepartementet' },
    { patterns: [/\b(digitaliserings-?\s*og\s*forvaltningsdepartementet|dfd)\b/i], name: 'Digitaliserings- og forvaltningsdepartementet' },
    { patterns: [/\b(finansdepartementet|fd)\b/i], name: 'Finansdepartementet' },
    { patterns: [/\b(forsvarsdepartementet|fd)\b/i], name: 'Forsvarsdepartementet' },
    { patterns: [/\b(helse-?\s*og\s*omsorgsdepartementet|hod)\b/i], name: 'Helse- og omsorgsdepartementet' },
    { patterns: [/\b(justis-?\s*og\s*beredskapsdepartementet|jbd)\b/i], name: 'Justis- og beredskapsdepartementet' },
    { patterns: [/\b(klima-?\s*og\s*miljødepartementet|kmd)\b/i], name: 'Klima- og miljødepartementet' },
    { patterns: [/\b(kommunal-?\s*og\s*distriktsdepartementet|kdd)\b/i], name: 'Kommunal- og distriktsdepartementet' },
    { patterns: [/\b(kultur-?\s*og\s*likestillingsdepartementet|kld)\b/i], name: 'Kultur- og likestillingsdepartementet' },
    { patterns: [/\b(nærings-?\s*og\s*fiskeridepartementet|nfd)\b/i], name: 'Nærings- og fiskeridepartementet' },
    { patterns: [/\b(olje-?\s*og\s*energidepartementet|oed)\b/i], name: 'Olje- og energidepartementet' },
    { patterns: [/\b(samferdselsdepartementet|sfd)\b/i], name: 'Samferdselsdepartementet' },
    { patterns: [/\b(utdannings-?\s*og\s*forskningsdepartementet|ufd)\b/i], name: 'Utdannings- og forskningsdepartementet' },
    { patterns: [/\b(utenriksdepartementet|ud)\b/i], name: 'Utenriksdepartementet' }
  ];
  
  // Check for ministry mentions
  for (const ministry of ministries) {
    for (const pattern of ministry.patterns) {
      if (pattern.test(lowerText)) {
        return ministry.name;
      }
    }
  }
  
  // Generic pattern for "departementet" or "departement"
  const genericPattern = /\b([A-ZÆØÅ][a-zæøå]+(?:-?\s*og\s*[a-zæøå]+)?departementet?)\b/i;
  const genericMatch = searchText.match(genericPattern);
  if (genericMatch) {
    return genericMatch[1];
  }
  
  return null;
}

async function backfillLawTypes() {
  const supabase = getSupabaseAdminClient();
  
  logger.info('Starting backfill of law_type values for documents and chunks...');
  
  // First, get count of documents that need updating
  // Use a query that counts all documents (we'll filter by null law_type in the actual processing)
  const { count: totalDocuments, error: countError } = await supabase
    .from('lovdata_documents')
    .select('id', { count: 'exact', head: true })
    .is('law_type', null);
  
  if (countError) {
    logger.error({ err: countError, errorMessage: countError.message, errorDetails: countError }, 'Failed to count documents');
    // Try alternative approach - count all documents
    const { count: allCount } = await supabase
      .from('lovdata_documents')
      .select('id', { count: 'exact', head: true });
    logger.info({ allDocumentsCount: allCount }, 'Total documents in database');
    return;
  }
  
  logger.info({ totalDocuments: totalDocuments ?? 0 }, 'Documents to process');
  
  if (!totalDocuments || totalDocuments === 0) {
    logger.info('No documents to update');
    return;
  }
  
  const batchSize = 50;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  const stats = {
    lawTypes: {} as Record<string, number>,
    years: {} as Record<string, number>,
    ministries: {} as Record<string, number>
  };
  
  // Track updated documents to update chunks in bulk
  interface UpdatedDocument {
    id: number;
    lawType: string | null;
    year: number | null;
    ministry: string | null;
  }
  const updatedDocuments: UpdatedDocument[] = [];
  
  // Process documents in batches
  for (let offset = 0; offset < totalDocuments; offset += batchSize) {
    logger.info({ 
      offset, 
      batchSize, 
      total: totalDocuments,
      progress: `${((offset / totalDocuments) * 100).toFixed(1)}%`
    }, 'Processing batch');
    
    // Fetch batch of documents with null law_type
    const { data: documents, error: fetchError } = await supabase
      .from('lovdata_documents')
      .select('id, title, document_date, content, law_type, year, ministry')
      .is('law_type', null)
      .range(offset, offset + batchSize - 1);
    
    if (fetchError) {
      logger.error({ err: fetchError, offset }, 'Failed to fetch documents batch');
      continue;
    }
    
    if (!documents || documents.length === 0) {
      break; // No more documents to process
    }
    
    // Process each document
    for (const doc of documents) {
      try {
        // Extract metadata from document content
        const lawType = extractLawType(doc.content, doc.title);
        const year = doc.year ?? extractYear(doc.content, doc.document_date);
        const ministry = doc.ministry ?? extractMinistry(doc.content, doc.title);
        
        // Update document
        const updates: { law_type?: string | null; year?: number | null; ministry?: string | null } = {};
        if (lawType !== null) {
          updates.law_type = lawType;
        }
        if (year !== null && doc.year === null) {
          updates.year = year;
        }
        if (ministry !== null && doc.ministry === null) {
          updates.ministry = ministry;
        }
        
        // Only update if we have something to update
        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await supabase
            .from('lovdata_documents')
            .update(updates)
            .eq('id', doc.id);
          
          if (updateError) {
            logger.error({ err: updateError, documentId: doc.id }, 'Failed to update document');
            skipped++;
          } else {
            updated++;
            
            // Track statistics
            if (lawType) {
              stats.lawTypes[lawType] = (stats.lawTypes[lawType] || 0) + 1;
            }
            if (year) {
              stats.years[String(year)] = (stats.years[String(year)] || 0) + 1;
            }
            if (ministry) {
              stats.ministries[ministry] = (stats.ministries[ministry] || 0) + 1;
            }
            
            // Track updated document for bulk chunk update (done after batch)
            updatedDocuments.push({
              id: doc.id,
              lawType: lawType ?? null,
              year: year ?? null,
              ministry: ministry ?? null
            });
          }
        } else {
          skipped++;
        }
        
        processed++;
      } catch (error) {
        logger.error({ err: error, documentId: doc.id }, 'Error processing document');
        skipped++;
      }
    }
    
    // Update chunks in bulk for documents that were updated in this batch
    // This is more efficient than updating chunks one document at a time
    // This is more efficient than updating chunks one document at a time
    if (updatedDocuments.length > 0) {
      logger.info({ count: updatedDocuments.length }, 'Updating chunks for documents in batch');
      
      // Group updates by unique combination of lawType/year/ministry to reduce queries
      const updateGroups = new Map<string, { ids: number[]; updates: { law_type?: string | null; year?: number | null; ministry?: string | null } }>();
      
      for (const docUpdate of updatedDocuments) {
        const key = `${docUpdate.lawType ?? 'null'}|${docUpdate.year ?? 'null'}|${docUpdate.ministry ?? 'null'}`;
        if (!updateGroups.has(key)) {
          const updates: { law_type?: string | null; year?: number | null; ministry?: string | null } = {};
          if (docUpdate.lawType !== null) updates.law_type = docUpdate.lawType;
          if (docUpdate.year !== null) updates.year = docUpdate.year;
          if (docUpdate.ministry !== null) updates.ministry = docUpdate.ministry;
          
          updateGroups.set(key, { ids: [], updates });
        }
        updateGroups.get(key)!.ids.push(docUpdate.id);
      }
      
      // Execute bulk updates
      for (const [key, group] of updateGroups) {
        if (group.ids.length > 0 && Object.keys(group.updates).length > 0) {
          try {
            const { error: chunkUpdateError } = await supabase
              .from('document_chunks')
              .update(group.updates)
              .in('document_id', group.ids);
            
            if (chunkUpdateError) {
              logger.warn({ err: chunkUpdateError, documentCount: group.ids.length, key }, 'Failed to bulk update chunks');
            } else {
              logger.debug({ documentCount: group.ids.length, key }, 'Bulk updated chunks');
            }
          } catch (error) {
            logger.warn({ err: error, documentCount: group.ids.length, key }, 'Error in bulk chunk update');
          }
        }
      }
      
      // Clear the batch
      updatedDocuments.length = 0;
    }
    
    // Log progress every batch
    logger.info({
      processed,
      updated,
      skipped,
      remaining: totalDocuments - processed
    }, 'Progress update');
  }
  
  logger.info({
    totalProcessed: processed,
    totalUpdated: updated,
    totalSkipped: skipped,
    stats
  }, 'Backfill completed');
  
  console.log('\n=== BACKFILL SUMMARY ===');
  console.log(`Documents processed: ${processed}`);
  console.log(`Documents updated: ${updated}`);
  console.log(`Documents skipped: ${skipped}`);
  console.log(`\nLaw type distribution:`, stats.lawTypes);
  console.log(`\nYear distribution:`, stats.years);
  console.log(`\nMinistry distribution:`, Object.keys(stats.ministries).slice(0, 10), '...');
}

backfillLawTypes()
  .then(() => {
    logger.info('Backfill script completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ err: error }, 'Backfill script failed');
    process.exit(1);
  });

