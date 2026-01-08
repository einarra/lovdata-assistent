import type { SkillContext, SkillIO, SkillOutput } from '../skills-core.js';
import { LovdataClient } from '../../services/lovdataClient.js';
import { searchLovdataPublicData, type LovdataSearchResult } from '../../services/lovdataSearch.js';
import type { SupabaseArchiveStore } from '../../storage/supabaseArchiveStore.js';
import { EmbeddingService } from '../../services/embeddingService.js';
import { logger } from '../../logger.js';
import { env } from '../../config/env.js';

type LovdataSkillInput =
  | { action: 'listPublicData' }
  | { action: 'fetchJson'; path: string; params?: Record<string, string | number | boolean | undefined> }
  | {
      action: 'searchPublicData';
      query: string;
      latest?: number;
      maxHits?: number;
      page?: number;
      pageSize?: number;
      filters?: {
        year?: number | null;
        lawType?: string | null;
        ministry?: string | null;
      };
    };

type Services = {
  lovdata?: LovdataClient;
  archive?: SupabaseArchiveStore | null;
};

export async function guard({ ctx, io }: { ctx: SkillContext; io: SkillIO }) {
  const services = (ctx.services ?? {}) as Services;
  if (!services.lovdata) {
    throw new Error('Lovdata client is not configured in skill context');
  }
  if (!services.archive) {
    throw new Error('Archive store is not available in skill context');
  }

  const normalized = normalizeInput(io.input);
  if (normalized.action === 'fetchJson' && !normalized.path) {
    throw new Error("'fetchJson' action requires a path");
  }
  if (normalized.action === 'searchPublicData' && !normalized.query) {
    throw new Error("'searchPublicData' action requires a query");
  }
}

export async function execute(io: SkillIO, ctx: SkillContext): Promise<SkillOutput> {
  const services = (ctx.services ?? {}) as Services;
  const client = services.lovdata;
  const archiveStore = services.archive ?? null;
  if (!client) {
    throw new Error('Lovdata client is not configured in skill context');
  }

  const command = normalizeInput(io.input);

  switch (command.action) {
    case 'listPublicData': {
      const result = await client.listPublicData();
      return {
        result,
        meta: {
          skill: 'lovdata-api',
          action: command.action
        }
      };
    }
    case 'searchPublicData': {
      const latest = command.latest ?? 3;
      const maxHits = command.maxHits ?? 200;
      const page = command.page && command.page > 0 ? Math.floor(command.page) : 1;
      const pageSize = command.pageSize && command.pageSize > 0 ? Math.min(Math.floor(command.pageSize), 50) : 10;

      if (!archiveStore) {
        throw new Error('Archive store is not available for Lovdata search');
      }

      // Generate query embedding once to reuse across all searches (OPTIMIZATION)
      // This enables hybrid search (vector + keyword) for better search quality
      // Enhance query with context to improve embedding quality and search relevance
      let queryEmbedding: number[] | null = null;
      try {
        // Access embedding service from archive store if available
        const embeddingService = (archiveStore as any).embeddingService as EmbeddingService | null;
        if (embeddingService) {
          // Enhance query with context to improve embedding quality
          // This helps the vector search better understand intent and reduce false positives
          const enhancedQuery = enhanceQueryForEmbedding(command.query, command.filters);
          queryEmbedding = await embeddingService.generateEmbedding(enhancedQuery);
          logger.debug({ 
            queryLength: command.query.length,
            enhancedQueryLength: enhancedQuery.length 
          }, 'Generated query embedding for search with enhanced context');
        }
      } catch (embeddingError) {
        logger.warn({ err: embeddingError }, 'Failed to generate query embedding - will fall back to FTS-only search');
      }

      // Determine if we should use prioritized search (when lawType is not specified)
      const usePrioritizedSearch = !command.filters?.lawType;
      const defaultLawTypePriority = ['Lov', 'Forskrift', 'Vedtak', 'Instruks', 'Reglement', 'Vedlegg'] as const;
      
      // Log search strategy
      logger.info({
        query: command.query,
        usePrioritizedSearch,
        lawType: command.filters?.lawType,
        year: command.filters?.year,
        ministry: command.filters?.ministry,
        pageSize,
        message: usePrioritizedSearch 
          ? 'Using prioritized search (no lawType specified)'
          : `Using direct search with lawType: ${command.filters?.lawType}`
      }, 'searchPublicData: search strategy');
      
      // Detect if query explicitly mentions a law type (e.g., "Forskrift til lov om...")
      // This helps prioritize the correct type even when both return results
      const queryLower = command.query.toLowerCase();
      const mentionsForskrift = /\bforskrift\b/i.test(command.query);
      const mentionsLov = /\blov\b/i.test(command.query) && !mentionsForskrift; // Only if not part of "forskrift til lov"
      
      let searchResult: LovdataSearchResult | null = null;
      
      if (usePrioritizedSearch) {
        
        // Try each law type in priority order until we get sufficient results
        const minResults = Math.max(3, Math.floor(pageSize * 0.5)); // Require at least 50% of requested results
        let bestResult: LovdataSearchResult | null = null;
        let searchedTypes: string[] = [];
        let foundEnoughResults = false;
        
        // OPTIMIZATION: Search Lov + Forskrift in parallel (Option C)
        // These are the two highest priority types, so search them together
        // Enable reranking for better result quality
        const enableReranking = env.ENABLE_RERANKING;
        const [lovResult, forskriftResult] = await Promise.all([
          searchLovdataPublicData({
            store: archiveStore,
            query: command.query, // Use original query for FTS (includes all terms)
            page,
            pageSize,
            enableReranking, // Enable reranking for better quality
            filters: {
              ...command.filters,
              lawType: 'Lov'
            },
            queryEmbedding, // Reuse pre-computed embedding (uses enhanced query with core terms)
            rrfK: env.RRF_K // Use configured RRF k parameter
          }),
          searchLovdataPublicData({
            store: archiveStore,
            query: command.query, // Use original query for FTS (includes all terms)
            page,
            pageSize,
            enableReranking, // Enable reranking for better quality
            filters: {
              ...command.filters,
              lawType: 'Forskrift'
            },
            queryEmbedding, // Reuse pre-computed embedding (uses enhanced query with core terms)
            rrfK: env.RRF_K // Use configured RRF k parameter
          })
        ]);
        
        searchedTypes.push('Lov', 'Forskrift');
        
        const lovHitCount = lovResult.hits?.length ?? 0;
        const forskriftHitCount = forskriftResult.hits?.length ?? 0;
        
        // Improved selection logic: prioritize based on query context and relevance
        // If query mentions "forskrift", prioritize Forskrift results even if Lov has more hits
        if (mentionsForskrift && forskriftHitCount > 0) {
          // Query explicitly mentions "forskrift" - prioritize Forskrift results
          searchResult = forskriftResult;
          foundEnoughResults = forskriftHitCount >= minResults;
          logger.info({
            query: command.query,
            mentionsForskrift: true,
            forskriftHits: forskriftHitCount,
            lovHits: lovHitCount,
            message: 'Query mentions "forskrift" - prioritizing Forskrift results'
          }, 'Prioritized search: query mentions forskrift');
        } else if (mentionsLov && lovHitCount > 0) {
          // Query explicitly mentions "lov" (and not "forskrift") - prioritize Lov results
          searchResult = lovResult;
          foundEnoughResults = lovHitCount >= minResults;
          logger.info({
            query: command.query,
            mentionsLov: true,
            lovHits: lovHitCount,
            forskriftHits: forskriftHitCount,
            message: 'Query mentions "lov" - prioritizing Lov results'
          }, 'Prioritized search: query mentions lov');
        } else {
          // No explicit mention - use standard logic: prefer type with more results
          if (lovHitCount >= minResults) {
            searchResult = lovResult;
            foundEnoughResults = true;
          } else if (forskriftHitCount >= minResults) {
            searchResult = forskriftResult;
            foundEnoughResults = true;
          } else {
            // Neither has enough results - choose the one with more hits
            if (forskriftHitCount >= lovHitCount) {
              bestResult = forskriftResult;
            } else {
              bestResult = lovResult;
            }
          }
        }
        
        // Track the best result so far (before checking remaining types)
        if (!foundEnoughResults && !bestResult) {
          // Initialize bestResult with the better of Lov or Forskrift
          if (forskriftHitCount >= lovHitCount) {
            bestResult = forskriftResult;
          } else {
            bestResult = lovResult;
          }
          
          // If neither gave enough results, try remaining types sequentially
          const remainingTypes = defaultLawTypePriority.slice(2); // Skip Lov and Forskrift (already searched)
          
          for (const lawType of remainingTypes) {
            const typeResult = await searchLovdataPublicData({
              store: archiveStore,
              query: command.query,
              page,
              pageSize,
              enableReranking, // Enable reranking for better quality
              filters: {
                ...command.filters,
                lawType
              },
              queryEmbedding, // Reuse pre-computed embedding
              rrfK: env.RRF_K // Use configured RRF k parameter
            });
            
            searchedTypes.push(lawType);
            
            // Track the best result so far
            const typeHitCount = typeResult.hits?.length ?? 0;
            if (!bestResult) {
              bestResult = typeResult;
            } else {
              const bestHitCount = bestResult.hits?.length ?? 0;
              if (typeHitCount > bestHitCount) {
                bestResult = typeResult;
              }
            }
            
            // If we got enough results, use this type
            if (typeResult.hits && typeResult.hits.length >= minResults) {
              searchResult = typeResult;
              foundEnoughResults = true;
              break;
            }
          }
        }
        
        // If no single type gave enough results, check if we found any results at all
        if (!searchResult) {
          if (bestResult && bestResult.hits && bestResult.hits.length > 0) {
            // Use the best result we found (even if it didn't meet minResults threshold)
            searchResult = bestResult;
            logger.info({
              query: command.query,
              bestResultHits: bestResult.hits.length,
              searchedTypes,
              message: 'Using best result from searched types'
            }, 'Prioritized search: using best result');
          } else {
            // No results found with any law type filter - try without filter
            // This handles the case where law_type might not be set in the database
            logger.info({
              query: command.query,
              searchedTypes,
              message: 'No results with law type filters - trying without filter'
            }, 'Prioritized search: falling back to unfiltered search');
            searchResult = await searchLovdataPublicData({
              store: archiveStore,
              query: command.query,
              page,
              pageSize,
              enableReranking, // Enable reranking for better quality
              filters: {
                ...command.filters,
                lawType: undefined // Remove lawType filter
              },
              queryEmbedding, // Reuse pre-computed embedding
              rrfK: env.RRF_K // Use configured RRF k parameter
            });
          }
        }
      } else {
        // Law type specified, use normal search with embedding for hybrid search
        // Enable reranking for better result quality
        const enableReranking = env.ENABLE_RERANKING;
        searchResult = await searchLovdataPublicData({
          store: archiveStore,
          query: command.query,
          page,
          pageSize,
          enableReranking, // Enable reranking for better quality
          filters: command.filters,
          queryEmbedding, // Use pre-computed embedding for hybrid search
          rrfK: env.RRF_K // Use configured RRF k parameter
        });
      }
      
      // Ensure searchResult is not null (TypeScript safety check)
      if (!searchResult) {
        throw new Error('Search failed to return any results');
      }

      const hits = searchResult.hits ?? [];
      const searchedFiles = searchResult.searchedFiles ?? [];
      const totalHits = searchResult.totalHits ?? 0;
      const totalPages = searchResult.totalPages ?? Math.max(1, Math.ceil(totalHits / pageSize));

      // Log search results for debugging
      logger.info({
        query: command.query,
        hitsCount: hits.length,
        totalHits,
        page,
        pageSize,
        totalPages,
        lawType: command.filters?.lawType,
        sampleTitles: hits.slice(0, 3).map(h => h.title),
        message: hits.length === 0 
          ? 'WARNING: No search results found'
          : `Found ${hits.length} results (${totalHits} total)`
      }, 'searchPublicData: search completed');

      // Serper fallback removed - agent will call serper directly when needed

      return {
        result: {
          query: command.query,
          hits,
          searchedFiles,
          page,
          pageSize,
          totalHits,
          totalPages
        },
        meta: {
          skill: 'lovdata-api',
          action: command.action,
          query: command.query,
          latest,
          maxHits,
          page,
          pageSize,
          totalHits,
          totalPages
        }
      };
    }
    case 'fetchJson': {
      const normalizedPath = command.path.startsWith('/') ? command.path : `/${command.path}`;
      const result = await client.getJson(normalizedPath, {
        params: command.params
      });
      return {
        result,
        meta: {
          skill: 'lovdata-api',
          action: command.action,
          path: normalizedPath,
          params: command.params
        }
      };
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported Lovdata action ${(exhaustive as any).action}`);
    }
  }
}

function normalizeInput(input: unknown): LovdataSkillInput {
  if (!input) {
    return { action: 'listPublicData' };
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('Lovdata skill requires non-empty input');
    }

    const text = trimmed.toLowerCase();
    if (text.includes('list') && text.includes('lovdata')) {
      return { action: 'listPublicData' };
    }
    const pathMatch = text.match(/lovdata\s+(?<path>\/[\w\-\d\/]+|v\d[^\s]*)/i);
    if (pathMatch?.groups?.path) {
      return { action: 'fetchJson', path: pathMatch.groups.path };
    }
    const inferredFilters = inferFiltersFromQuery(trimmed);
    return { action: 'searchPublicData', query: trimmed, filters: inferredFilters };
  }

  if (typeof input === 'object') {
    const candidate = input as Partial<LovdataSkillInput> & { action?: string };
    if (candidate.action === 'listPublicData') {
      return { action: 'listPublicData' };
    }
    if (candidate.action === 'fetchJson') {
      if (!candidate.path || typeof candidate.path !== 'string') {
        throw new Error("'fetchJson' action requires a string path");
      }
      return {
        action: 'fetchJson',
        path: candidate.path,
        params: candidate.params
      };
    }
    if (candidate.action === 'searchPublicData') {
      if (!('query' in candidate) || typeof candidate.query !== 'string' || candidate.query.trim().length === 0) {
        throw new Error("'searchPublicData' action requires a query string");
      }
      const query = candidate.query.trim();
      // Infer filters from query if not explicitly provided
      const inferredFilters = candidate.filters ?? inferFiltersFromQuery(query);
      
      // Log inferred filters for debugging
      if (inferredFilters.lawType || inferredFilters.year || inferredFilters.ministry) {
        logger.debug({
          query,
          inferredFilters,
          message: 'Inferred filters from query'
        }, 'normalizeInput: inferred filters');
      }
      
      return {
        action: 'searchPublicData',
        query,
        latest: candidate.latest,
        maxHits: candidate.maxHits,
        page: candidate.page,
        pageSize: candidate.pageSize,
        filters: inferredFilters
      };
    }
  }

  throw new Error('Unsupported Lovdata skill input shape');
}

/**
 * Enhances query text for embedding generation to improve relevance.
 * Adds context about what we're looking for to reduce false positives.
 * @param query - Original search query
 * @param filters - Optional filters (lawType, year, ministry)
 * @returns Enhanced query text
 */
/**
 * Extracts core search terms from queries that mention law types.
 * For example: "Forskrift til lov om register over reelle rettighetshavere"
 * Should extract: "register over reelle rettighetshavere" as the core terms
 */
function extractCoreSearchTerms(query: string): string {
  // Remove common law type prefixes that don't help with search
  // Patterns like "Forskrift til lov om...", "Lov om...", etc.
  const cleaned = query
    .replace(/^(?:forskrift\s+til\s+)?(?:lov\s+om\s+)/i, '') // "Forskrift til lov om..." or "Lov om..."
    .replace(/^forskrift\s+til\s+/i, '') // "Forskrift til..."
    .replace(/^lov\s+om\s+/i, '') // "Lov om..."
    .replace(/^forskrift\s+om\s+/i, '') // "Forskrift om..."
    .trim();
  
  // If cleaning removed everything, use original query
  return cleaned.length > 0 ? cleaned : query;
}

function enhanceQueryForEmbedding(
  query: string,
  filters?: { lawType?: string | null; year?: number | null; ministry?: string | null }
): string {
  const parts: string[] = [];
  
  // Extract core search terms (remove law type prefixes)
  const coreTerms = extractCoreSearchTerms(query);
  
  // Add context about what we're searching for
  parts.push('Søk etter juridiske dokumenter om:');
  parts.push(coreTerms); // Use core terms instead of full query
  
  // Add filter context if available to narrow down search
  if (filters?.lawType) {
    parts.push(`Dokumenttype: ${filters.lawType}`);
  }
  if (filters?.year) {
    parts.push(`År: ${filters.year}`);
  }
  if (filters?.ministry) {
    parts.push(`Departement: ${filters.ministry}`);
  }
  
  // Add instruction to exclude irrelevant laws
  // This helps the embedding model understand we want specific, relevant results
  parts.push('Finn relevante dokumenter som direkte svarer på spørsmålet.');
  
  return parts.join('\n');
}

/**
 * Infers metadata filters from user query text.
 * Extracts year, law type, and ministry mentions from natural language queries.
 */
function inferFiltersFromQuery(query: string): {
  year?: number | null;
  lawType?: string | null;
  ministry?: string | null;
} {
  const filters: {
    year?: number | null;
    lawType?: string | null;
    ministry?: string | null;
  } = {};

  const lowerQuery = query.toLowerCase();

  // Extract year (e.g., "from 2023", "in 2023", "2023 laws", "laws from 2023")
  const yearPatterns = [
    /(?:fra|from|i|in|år|year)\s+(\d{4})\b/i,
    /\b(\d{4})\s+(?:lov|forskrift|vedtak|reglement)/i,
    /\b(19|20)\d{2}\b/
  ];

  for (const pattern of yearPatterns) {
    const match = query.match(pattern);
    if (match) {
      const year = parseInt(match[1] || match[0], 10);
      if (year >= 1900 && year <= 2100) {
        filters.year = year;
        break;
      }
    }
  }

  // Extract law type - prioritize "forskrift til lov" patterns
  // Check for "forskrift til lov" first (most specific pattern)
  if (/\bforskrift\s+til\s+lov\b/i.test(query) || /\bforskrift\s+til\s+.*lov\b/i.test(query)) {
    filters.lawType = 'Forskrift';
  } else {
    // Check other law type patterns
    const lawTypePatterns = [
      { pattern: /\bforskrift\b/i, type: 'Forskrift' }, // Check forskrift before lov to catch "forskrift" mentions
      { pattern: /\blov\b/i, type: 'Lov' }, // But not if it's part of "forskrift til lov"
      { pattern: /\b(vedtak|decision)\b/i, type: 'Vedtak' },
      { pattern: /\b(cirkulær|circular)\b/i, type: 'Cirkulær' },
      { pattern: /\b(rundskriv|circular letter)\b/i, type: 'Rundskriv' },
      { pattern: /\b(instruks|instruction)\b/i, type: 'Instruks' },
      { pattern: /\b(reglement|regulations)\b/i, type: 'Reglement' }
    ];

    for (const { pattern, type } of lawTypePatterns) {
      if (pattern.test(query)) {
        filters.lawType = type;
        break;
      }
    }
  }

  // Extract ministry (common Norwegian ministries)
  const ministries = [
    { patterns: [/\b(arbeids-?\s*og\s*sosialdepartementet|arbeidsdepartementet)\b/i], name: 'Arbeids- og sosialdepartementet' },
    { patterns: [/\b(barne-?\s*og\s*familiedepartementet|barnefamiliedepartementet)\b/i], name: 'Barne- og familiedepartementet' },
    { patterns: [/\b(digitaliserings-?\s*og\s*forvaltningsdepartementet)\b/i], name: 'Digitaliserings- og forvaltningsdepartementet' },
    { patterns: [/\b(finansdepartementet)\b/i], name: 'Finansdepartementet' },
    { patterns: [/\b(forsvarsdepartementet)\b/i], name: 'Forsvarsdepartementet' },
    { patterns: [/\b(helse-?\s*og\s*omsorgsdepartementet)\b/i], name: 'Helse- og omsorgsdepartementet' },
    { patterns: [/\b(justis-?\s*og\s*beredskapsdepartementet|justisdepartementet)\b/i], name: 'Justis- og beredskapsdepartementet' },
    { patterns: [/\b(klima-?\s*og\s*miljødepartementet)\b/i], name: 'Klima- og miljødepartementet' },
    { patterns: [/\b(kommunal-?\s*og\s*distriktsdepartementet)\b/i], name: 'Kommunal- og distriktsdepartementet' },
    { patterns: [/\b(kultur-?\s*og\s*likestillingsdepartementet)\b/i], name: 'Kultur- og likestillingsdepartementet' },
    { patterns: [/\b(nærings-?\s*og\s*fiskeridepartementet)\b/i], name: 'Nærings- og fiskeridepartementet' },
    { patterns: [/\b(olje-?\s*og\s*energidepartementet)\b/i], name: 'Olje- og energidepartementet' },
    { patterns: [/\b(samferdselsdepartementet)\b/i], name: 'Samferdselsdepartementet' },
    { patterns: [/\b(utdannings-?\s*og\s*forskningsdepartementet)\b/i], name: 'Utdannings- og forskningsdepartementet' },
    { patterns: [/\b(utenriksdepartementet)\b/i], name: 'Utenriksdepartementet' }
  ];

  for (const ministry of ministries) {
    for (const pattern of ministry.patterns) {
      if (pattern.test(query)) {
        filters.ministry = ministry.name;
        return filters; // Return early once ministry is found
      }
    }
  }

  return filters;
}

export const __test__ = {
  normalizeInput,
  inferFiltersFromQuery
};
