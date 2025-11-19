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
  const site = input.site ?? env.SERPER_SITE_FILTER;
  
  logger.info({ 
    hasClient: !!client,
    query: input.query,
    site,
    hasApiKey: !!env.SERPER_API_KEY
  }, 'lovdata-serper: checking client configuration');
  
  if (!client) {
    logger.warn('lovdata-serper: client not available, returning unconfigured message');
    return {
      result: {
        message: 'Serper API-nøkkel er ikke konfigurert. Sett SERPER_API_KEY for å aktivere nettsøk.',
        query: input.query,
        site
      },
      meta: {
        skill: 'lovdata-serper',
        action: 'search',
        configured: false
      }
    };
  }

  logger.info({ query: input.query, site }, 'lovdata-serper: calling client.search');
  
  let response;
  try {
    response = await client.search(input.query, {
      num: input.num,
      gl: input.gl,
      hl: input.hl,
      site
    });
    logger.info({ 
      hasOrganic: !!response.organic,
      organicCount: Array.isArray(response.organic) ? response.organic.length : 0
    }, 'lovdata-serper: client.search completed');
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
    date: item.date ?? null
  }));

  logger.info({ organicCount: organic.length }, 'lovdata-serper: processing results');

  return {
    result: {
      query: input.query,
      site,
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
      hl: candidate.hl
    };
  }

  throw new Error('Unsupported Serper skill input shape');
}

export const __test__ = {
  normalizeInput
};
