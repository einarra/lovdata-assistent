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
