import type { ArchiveSearchResult as StoreSearchResult } from '../storage/types.js';
import type { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';
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
}): Promise<LovdataSearchResult> {
  const { store, query } = options;
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, Math.min(options.pageSize, 50));
  const offset = Math.max(0, (page - 1) * pageSize);

  const searchTimer = new Timer('search_lovdata', logger, {
    query: query.substring(0, 100), // Log first 100 chars of query
    queryLength: query.length,
    page,
    pageSize,
    offset
  });

  logger.info({ query: query.substring(0, 100), page, pageSize }, 'searchLovdataPublicData: calling store.searchAsync');
  
  // Use async search method for Supabase
  let result: StoreSearchResult;
  try {
    result = await store.searchAsync(query, {
      limit: pageSize,
      offset
    });
    logger.info({ 
      hitsCount: result.hits.length,
      total: result.total
    }, 'searchLovdataPublicData: store.searchAsync completed');
  } catch (searchError) {
    logger.error({ 
      err: searchError,
      query: query.substring(0, 100)
    }, 'searchLovdataPublicData: store.searchAsync failed');
    throw searchError;
  }

  const searchedFiles = Array.from(new Set(result.hits.map(hit => hit.filename)));
  const totalPages = result.total === 0 ? 1 : Math.max(1, Math.ceil(result.total / pageSize));

  searchTimer.end({
    totalHits: result.total,
    hitsReturned: result.hits.length,
    searchedFilesCount: searchedFiles.length,
    totalPages
  });

  return {
    hits: result.hits.map(hit => ({
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
