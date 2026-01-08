import type { SkillContext, SkillIO, SkillOutput } from '../skills-core.js';
import { SerperClient } from '../../services/serperClient.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';

type SerperSkillInput = {
  action?: 'search';
  query: string;
  num?: number;
  site?: string;
  gl?: string;
  hl?: string;
  targetDocuments?: boolean; // If true, prioritize document pages
};

type Services = {
  serper?: SerperClient;
};

export async function guard({ io }: { ctx: SkillContext; io: SkillIO }) {
  const normalized = normalizeInput(io.input);
  if (!normalized.query) {
    throw new Error('Search query is required for the Serper skill.');
  }
}

export async function execute(io: SkillIO, ctx: SkillContext): Promise<SkillOutput> {
  logger.info('lovdata-serper: execute starting');
  
  const services = (ctx.services ?? {}) as Services;
  const client = services.serper;
  const input = normalizeInput(io.input);
  
  logger.info({ 
    hasClient: !!client,
    query: input.query,
    hasApiKey: !!env.SERPER_API_KEY
  }, 'lovdata-serper: checking client configuration');
  
  if (!client) {
    logger.warn('lovdata-serper: client not available, returning unconfigured message');
    return {
      result: {
        message: 'Serper API-nøkkel er ikke konfigurert. Sett SERPER_API_KEY for å aktivere nettsøk.',
        query: input.query
      },
      meta: {
        skill: 'lovdata-serper',
        action: 'search',
        configured: false
      }
    };
  }
  
  logger.info({ 
    query: input.query,
    searchStrategy: 'lovdata.no and domstol.no with targetDocuments'
  }, 'lovdata-serper: calling client.search on both sites');
  
  let lovdataResponse: Awaited<ReturnType<typeof client.search>>;
  let domstolResponse: Awaited<ReturnType<typeof client.search>>;
  
  try {
    // Search on both lovdata.no and domstol.no with targetDocuments to get actual document links
    // This ensures we get links to documents, not search/register pages
    const searchOptions = {
      num: input.num ? Math.ceil(input.num / 2) : 5, // Split the requested number between both sites
      gl: input.gl ?? 'no',
      hl: input.hl ?? 'no',
      targetDocuments: true // This will use inurl patterns to find document links
    };
    
    // Perform both searches in parallel
    const [lovdataResult, domstolResult] = await Promise.all([
      client.search(input.query, {
        ...searchOptions,
        site: 'lovdata.no'
      }),
      client.search(input.query, {
        ...searchOptions,
        site: 'domstol.no'
      })
    ]);
    
    lovdataResponse = lovdataResult;
    domstolResponse = domstolResult;
    
    logger.info({ 
      lovdataOrganicCount: Array.isArray(lovdataResponse.organic) ? lovdataResponse.organic.length : 0,
      domstolOrganicCount: Array.isArray(domstolResponse.organic) ? domstolResponse.organic.length : 0
    }, 'lovdata-serper: both searches completed');
    
    // Merge results from both sites
    const mergedOrganic = [
      ...(lovdataResponse.organic ?? []),
      ...(domstolResponse.organic ?? [])
    ];
    
    // Create merged response
    const mergedResponse: Awaited<ReturnType<typeof client.search>> = {
      ...lovdataResponse,
      organic: mergedOrganic
    };
    
    // Prioritize document links in merged results
    const response = SerperClient.prioritizeDocumentLinks(mergedResponse);
    
    // Limit to requested number if specified
    if (input.num && response.organic && response.organic.length > input.num) {
      response.organic = response.organic.slice(0, input.num);
    }
    
    logger.info({ 
      totalOrganicCount: response.organic?.length ?? 0
    }, 'lovdata-serper: results merged and prioritized');
    
    const organic = (response.organic ?? []).map(item => ({
      title: item.title ?? null,
      link: item.link ?? null,
      snippet: item.snippet ?? null,
      date: item.date ?? null,
      isDocument: SerperClient.isDocumentLink(item.link) // Add flag to indicate if it's a document link
    }));

    logger.info({ 
      organicCount: organic.length
    }, 'lovdata-serper: processing results');

    return {
      result: {
        query: input.query,
        organic
      },
      meta: {
        skill: 'lovdata-serper',
        action: 'search',
        totalOrganicResults: organic.length
      }
    };
  } catch (searchError) {
    logger.error({ 
      err: searchError,
      stack: searchError instanceof Error ? searchError.stack : undefined
    }, 'lovdata-serper: client.search failed');
    throw searchError;
  }
}

function normalizeInput(input: unknown): SerperSkillInput {
  if (typeof input === 'string') {
    return { action: 'search', query: input.trim() };
  }

  if (input && typeof input === 'object') {
    const candidate = input as Partial<SerperSkillInput> & { query?: unknown };
    if (!candidate.query || typeof candidate.query !== 'string') {
      throw new Error('Serper skill requires a string query');
    }
    
    return {
      action: 'search',
      query: candidate.query.trim(),
      num: candidate.num,
      site: candidate.site,
      gl: candidate.gl,
      hl: candidate.hl,
      targetDocuments: candidate.targetDocuments
    };
  }

  throw new Error('Unsupported Serper skill input shape');
}

export const __test__ = {
  normalizeInput
};
