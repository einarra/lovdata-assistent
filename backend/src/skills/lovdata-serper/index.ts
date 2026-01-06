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
    searchStrategy: 'lovdata.no with targetDocuments'
  }, 'lovdata-serper: calling client.search on lovdata.no');
  
  let response;
  try {
    // Search on lovdata.no with targetDocuments to get actual document links
    // This ensures we get links to documents, not search/register pages
    response = await client.search(input.query, {
      num: input.num,
      gl: input.gl ?? 'no',
      hl: input.hl ?? 'no',
      site: 'lovdata.no',
      targetDocuments: true // This will use inurl patterns to find document links
    });
    
    logger.info({ 
      hasOrganic: !!response.organic,
      organicCount: Array.isArray(response.organic) ? response.organic.length : 0
    }, 'lovdata-serper: client.search completed');
    
    // Prioritize document links in results
    response = SerperClient.prioritizeDocumentLinks(response);
  } catch (searchError) {
    logger.error({ 
      err: searchError,
      stack: searchError instanceof Error ? searchError.stack : undefined
    }, 'lovdata-serper: client.search failed');
    throw searchError;
  }

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
