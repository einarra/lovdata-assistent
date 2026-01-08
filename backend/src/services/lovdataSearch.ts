import type { ArchiveSearchResult as StoreSearchResult } from '../storage/types.js';
import type { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';
import { RerankService, type RerankCandidate } from './rerankService.js';
import { env } from '../config/env.js';
import { Timer } from '../utils/timing.js';
import { logger } from '../logger.js';

export type LovdataArchiveHit = {
  filename: string;
  member: string;
  title: string | null;
  date: string | null;
  snippet: string;
  url: string | null; // Web link to the document (API HTML viewer URL from RAG system)
};

export type LovdataSearchResult = {
  hits: LovdataArchiveHit[];
  searchedFiles: string[];
  totalHits: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export async function searchLovdataPublicData(options: {
  store: SupabaseArchiveStore;
  query: string;
  page: number;
  pageSize: number;
  enableReranking?: boolean;
  rerankTopN?: number; // Number of candidates to retrieve for re-ranking (default: 50)
  filters?: {
    year?: number | null;
    lawType?: string | null;
    ministry?: string | null;
  };
  queryEmbedding?: number[] | null; // Optional pre-computed query embedding to avoid regeneration
  rrfK?: number; // Optional RRF k parameter
}): Promise<LovdataSearchResult> {
  const { store, query } = options;
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, Math.min(options.pageSize, 50));
  const offset = Math.max(0, (page - 1) * pageSize);
  const enableReranking = options.enableReranking ?? (env.ENABLE_RERANKING && !!env.COHERE_API_KEY);
  const rerankTopN = options.rerankTopN ?? 50; // Retrieve 50 candidates for re-ranking

  const searchTimer = new Timer('search_lovdata', logger, {
    query: query.substring(0, 100),
    queryLength: query.length,
    page,
    pageSize,
    offset,
    enableReranking
  });

  logger.info({ 
    query: query.substring(0, 100), 
    page, 
    pageSize,
    enableReranking,
    rerankTopN: enableReranking ? rerankTopN : undefined
  }, 'searchLovdataPublicData: calling store.searchAsync');
  
  // Retrieve more candidates if re-ranking is enabled
  // When re-ranking, we need to get enough candidates to cover the requested page
  const candidateLimit = enableReranking 
    ? Math.max(rerankTopN, offset + pageSize) // Get enough to cover the requested page
    : pageSize;
  
  // Use async search method for Supabase
  let result: StoreSearchResult;
  try {
    result = await store.searchAsync(query, {
      limit: candidateLimit,
      offset: enableReranking ? 0 : offset, // Start from 0 when re-ranking, use offset otherwise
      filters: options.filters,
      queryEmbedding: options.queryEmbedding, // Pass through pre-computed embedding
      rrfK: options.rrfK // Pass through RRF k parameter
    });
    logger.info({ 
      hitsCount: result.hits.length,
      total: result.total,
      candidateLimit
    }, 'searchLovdataPublicData: store.searchAsync completed');
  } catch (searchError) {
    logger.error({ 
      err: searchError,
      query: query.substring(0, 100)
    }, 'searchLovdataPublicData: store.searchAsync failed');
    throw searchError;
  }

  let finalHits = result.hits;

  // Boost base laws over amendment laws
  // Amendment laws typically have titles like "Lov om endring i..." or "Lov om endringer i..."
  // Base laws are the actual laws themselves (e.g., "Lov 4. juli 1991 nr. 47 om ekteskap")
  const isAmendmentLaw = (title: string | null): boolean => {
    if (!title) return false;
    const titleLower = title.toLowerCase();
    return titleLower.includes('endring') || 
           titleLower.includes('endringer') ||
           titleLower.includes('ikraftsetting') ||
           titleLower.includes('ikraftsetjing') ||
           titleLower.includes('ikrafttredelse') ||
           titleLower.includes('delegering') ||
           titleLower.includes('overføring') ||
           titleLower.includes('opphevelse') ||
           titleLower.startsWith('forskrift');
  };
  
  // Check if a title matches the exact base law pattern
  // Base laws typically have format: "Lov [date] nr. [number] om [subject]"
  // Example: "Lov 4. juli 1991 nr. 47 om ekteskap"
  const isExactBaseLaw = (title: string | null, query: string): boolean => {
    if (!title) return false;
    const titleLower = title.toLowerCase();
    const queryLower = query.toLowerCase();
    
    // Check if query mentions a law name (e.g., "ekteskapsloven")
    // and if title matches the official law pattern without "endring" etc.
    const lawNamePatterns = [
      { 
        name: 'ekteskapsloven', 
        patterns: [
          /^lov\s+4\.?\s+juli\s+1991\s+nr\.?\s+47\s+om\s+ekteskap/i,
          /^lov\s+4\s+juli\s+1991\s+nr\s+47\s+om\s+ekteskap/i,
          /lov\s+1991\s+nr\.?\s+47\s+om\s+ekteskap/i,
        ]
      },
      { 
        name: 'ekteskapslova', 
        patterns: [
          /^lov\s+4\.?\s+juli\s+1991\s+nr\.?\s+47\s+om\s+ekteskap/i,
          /^lov\s+4\s+juli\s+1991\s+nr\s+47\s+om\s+ekteskap/i,
          /lov\s+1991\s+nr\.?\s+47\s+om\s+ekteskap/i,
        ]
      },
    ];
    
    for (const { name, patterns } of lawNamePatterns) {
      if (queryLower.includes(name)) {
        for (const pattern of patterns) {
          if (pattern.test(titleLower)) {
            // Make sure it's not an amendment law
            if (!isAmendmentLaw(title)) {
              return true;
            }
          }
        }
      }
    }
    
    // Also check for exact match pattern: "Lov [date] nr. [number] om [subject]"
    // without "endring", "forskrift", etc. at the start
    // This catches base laws even if the query doesn't mention the law name
    const exactLawPattern = /^lov\s+\d+\.?\s+\w+\s+\d+\s+nr\.?\s+\d+\s+om\s+/i;
    if (exactLawPattern.test(titleLower) && !isAmendmentLaw(title)) {
      // Additional check: if query mentions "ekteskap", prioritize laws about ekteskap
      if (queryLower.includes('ekteskap') && titleLower.includes('ekteskap')) {
        return true;
      }
      // If query doesn't mention ekteskap, still consider it a base law (but lower priority)
      // This will be handled by the three-tier boosting
    }
    
    return false;
  };

  const boostBaseLaws = (hits: typeof result.hits, searchQuery: string): typeof result.hits => {
    // Separate exact base laws, other base laws, and amendment laws
    const exactBaseLaws: typeof result.hits = [];
    const otherBaseLaws: typeof result.hits = [];
    const amendmentLaws: typeof result.hits = [];
    
    for (const hit of hits) {
      if (isAmendmentLaw(hit.title)) {
        amendmentLaws.push(hit);
      } else if (isExactBaseLaw(hit.title, searchQuery)) {
        exactBaseLaws.push(hit);
      } else {
        otherBaseLaws.push(hit);
      }
    }
    
    // Return exact base laws first (highest priority), then other base laws, then amendment laws
    // This ensures the actual law appears before laws that change it
    return [...exactBaseLaws, ...otherBaseLaws, ...amendmentLaws];
  };

  // Apply base law boosting before re-ranking
  finalHits = boostBaseLaws(result.hits, query);

  // Re-rank results if enabled and we have candidates
  if (enableReranking && finalHits.length > 0) {
    try {
      const rerankTimer = new Timer('rerank_results', logger, {
        query: query.substring(0, 100),
        candidateCount: result.hits.length
      });

      // Initialize re-ranking service
      const rerankService = new RerankService({ logger });
      
      // Prepare candidates for re-ranking
      // Use finalHits (with base law boosting) instead of result.hits
      const candidates: RerankCandidate[] = finalHits.map((hit, idx) => ({
        text: `${hit.title || ''} ${hit.snippet}`.trim(),
        metadata: {
          filename: hit.filename,
          member: hit.member,
          title: hit.title,
          date: hit.date,
          snippet: hit.snippet,
          isBaseLaw: !isAmendmentLaw(hit.title) // Add flag for base law
        },
        index: idx
      }));

      // Re-rank candidates - get enough results to cover the requested page
      // We need at least (offset + pageSize) results, but can get more for better quality
      const rerankLimit = Math.min(offset + pageSize + 5, candidates.length); // Get a few extra for buffer
      const rerankedResults = await rerankService.rerank(query, candidates, rerankLimit);
      rerankTimer.end({ rerankedCount: rerankedResults.length });

      // Map re-ranked results back to hits
      // Use finalHits (with base law boosting) instead of result.hits
      const rerankedHits = rerankedResults
        .map(reranked => finalHits[reranked.index])
        .filter(hit => hit !== undefined);
      
      // Apply additional boost to base laws after re-ranking
      // This ensures base laws stay at the top even after semantic re-ranking
      const exactBaseLawsAfterRerank: typeof rerankedHits = [];
      const otherBaseLawsAfterRerank: typeof rerankedHits = [];
      const amendmentLawsAfterRerank: typeof rerankedHits = [];
      
      for (const hit of rerankedHits) {
        if (isAmendmentLaw(hit.title)) {
          amendmentLawsAfterRerank.push(hit);
        } else if (isExactBaseLaw(hit.title, query)) {
          exactBaseLawsAfterRerank.push(hit);
        } else {
          otherBaseLawsAfterRerank.push(hit);
        }
      }
      
      // Combine: exact base laws first (highest priority), then other base laws, then amendment laws
      // This ensures the actual law appears before laws that change it
      finalHits = [...exactBaseLawsAfterRerank, ...otherBaseLawsAfterRerank, ...amendmentLawsAfterRerank];
      
      // Apply pagination to final results
      finalHits = finalHits.slice(offset, offset + pageSize);

      logger.info({
        originalCount: result.hits.length,
        rerankedCount: finalHits.length,
        pageSize
      }, 'searchLovdataPublicData: re-ranking completed');

    } catch (rerankError) {
      // Log error but continue with original results
      logger.warn({ 
        err: rerankError,
        query: query.substring(0, 100)
      }, 'searchLovdataPublicData: re-ranking failed, using original results');
      // Use original results with pagination
      finalHits = result.hits.slice(offset, offset + pageSize);
    }
  } else {
    // No re-ranking - apply pagination to original results
    finalHits = result.hits.slice(offset, offset + pageSize);
  }

  const searchedFiles = Array.from(new Set(finalHits.map(hit => hit.filename)));
  const totalPages = result.total === 0 ? 1 : Math.max(1, Math.ceil(result.total / pageSize));

  searchTimer.end({
    totalHits: result.total,
    hitsReturned: finalHits.length,
    searchedFilesCount: searchedFiles.length,
    totalPages,
    reranked: enableReranking && result.hits.length > 0
  });

  // Build URLs for each hit using the API HTML viewer endpoint
  // Convert .xml members to .html for the viewer URL to ensure links point to HTML content
  const buildHtmlViewerUrl = (filename: string | undefined, member: string | undefined): string | null => {
    if (!filename || !member) {
      return null;
    }
    try {
      // Convert .xml member to .html for the viewer URL
      const htmlMember = member.toLowerCase().endsWith('.xml')
        ? member.replace(/\.xml$/i, '.html')
        : member;
      const url = new URL('/api/documents/xml', env.PUBLIC_API_BASE_URL);
      url.searchParams.set('filename', filename);
      url.searchParams.set('member', htmlMember);
      return url.toString();
    } catch (error) {
      logger.error({ err: error, filename, member }, 'Failed to build HTML viewer URL');
      return null;
    }
  };

  return {
    hits: finalHits.map(hit => ({
      filename: hit.filename,
      member: hit.member,
      title: hit.title,
      date: hit.date,
      snippet: hit.snippet,
      url: buildHtmlViewerUrl(hit.filename, hit.member) // Include web link to HTML document viewer
    })),
    searchedFiles,
    totalHits: result.total,
    page,
    pageSize,
    totalPages
  };
}
