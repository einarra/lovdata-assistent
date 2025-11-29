import type { SkillContext, SkillIO, SkillOutput } from '../skills-core.js';
import { LovdataClient } from '../../services/lovdataClient.js';
import { SerperClient } from '../../services/serperClient.js';
import { searchLovdataPublicData, type LovdataSearchResult } from '../../services/lovdataSearch.js';
import type { SupabaseArchiveStore } from '../../storage/supabaseArchiveStore.js';

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
  serper?: SerperClient;
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

      const searchResult: LovdataSearchResult = await searchLovdataPublicData({
        store: archiveStore,
        query: command.query,
        page,
        pageSize,
        filters: command.filters
      });

      const hits = searchResult?.hits ?? [];
      const searchedFiles = searchResult?.searchedFiles ?? [];
      const totalHits = searchResult?.totalHits ?? 0;
      const totalPages = searchResult?.totalPages ?? Math.max(1, Math.ceil(totalHits / pageSize));

      let fallbackInfo:
        | {
            provider: string;
            organic: Array<{
              title: string | null;
              link: string | null;
              snippet: string | null;
              date: string | null;
            }>;
          }
        | undefined;

      if (services.serper) {
        const shouldFetchFallback =
          hits.length === 0 ||
          hits.length < Math.min(pageSize, 5) ||
          totalHits === 0;
        if (shouldFetchFallback) {
          // Use document-targeted search to get direct links to Lovdata documents
          const fallback = await services.serper.searchDocuments(command.query, { num: 10 });
          // Prioritize document links in results
          const prioritized = SerperClient.prioritizeDocumentLinks(fallback);
          fallbackInfo = {
            provider: 'serper',
            organic: (prioritized.organic ?? []).map(item => ({
              title: item.title ?? null,
              link: item.link ?? null,
              snippet: item.snippet ?? null,
              date: item.date ?? null
            }))
          };
        }
      }

      return {
        result: {
          query: command.query,
          hits,
          searchedFiles,
          page,
          pageSize,
          totalHits,
          totalPages,
          fallback: fallbackInfo
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
          totalPages,
          fallbackProvider: fallbackInfo?.provider
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

  // Extract law type
  const lawTypePatterns = [
    { pattern: /\b(lov|act)\b/i, type: 'Lov' },
    { pattern: /\b(forskrift|regulation)\b/i, type: 'Forskrift' },
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
