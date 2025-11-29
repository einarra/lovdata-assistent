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
      filters: options.filters
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

  // Re-rank results if enabled and we have candidates
  if (enableReranking && result.hits.length > 0) {
    try {
      const rerankTimer = new Timer('rerank_results', logger, {
        query: query.substring(0, 100),
        candidateCount: result.hits.length
      });

      // Initialize re-ranking service
      const rerankService = new RerankService({ logger });
      
      // Prepare candidates for re-ranking
      const candidates: RerankCandidate[] = result.hits.map((hit, idx) => ({
        text: `${hit.title || ''} ${hit.snippet}`.trim(),
        metadata: {
          filename: hit.filename,
          member: hit.member,
          title: hit.title,
          date: hit.date,
          snippet: hit.snippet
        },
        index: idx
      }));

      // Re-rank candidates - get enough results to cover the requested page
      // We need at least (offset + pageSize) results, but can get more for better quality
      const rerankLimit = Math.min(offset + pageSize + 5, candidates.length); // Get a few extra for buffer
      const rerankedResults = await rerankService.rerank(query, candidates, rerankLimit);
      rerankTimer.end({ rerankedCount: rerankedResults.length });

      // Map re-ranked results back to hits
      const rerankedHits = rerankedResults
        .map(reranked => result.hits[reranked.index])
        .filter(hit => hit !== undefined);
      
      // Apply pagination to re-ranked results
      finalHits = rerankedHits.slice(offset, offset + pageSize);

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

  return {
    hits: finalHits.map(hit => ({
      filename: hit.filename,
      member: hit.member,
      title: hit.title,
      date: hit.date,
      snippet: hit.snippet
    })),
    searchedFiles,
    totalHits: result.total,
    page,
    pageSize,
    totalPages
  };
}
