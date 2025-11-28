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

  logger.info({ query: input.query, site, targetDocuments: input.targetDocuments }, 'lovdata-serper: calling client.search');
  
  let response;
  try {
    // Use document-targeted search if requested, or default to true for lovdata.no
    const shouldTargetDocuments = input.targetDocuments ?? (site === 'lovdata.no' || site?.includes('lovdata.no'));
    
    if (shouldTargetDocuments) {
      // Try document-specific search first
      response = await client.searchDocuments(input.query, {
        num: input.num,
        gl: input.gl,
        hl: input.hl,
        site
      });
      logger.info({ 
        hasOrganic: !!response.organic,
        organicCount: Array.isArray(response.organic) ? response.organic.length : 0
      }, 'lovdata-serper: client.searchDocuments completed');
      
      // If we got few results, also try a general search and merge
      if (!response.organic || response.organic.length < 3) {
        logger.info('lovdata-serper: document search returned few results, trying general search');
        try {
          const generalResponse = await client.search(input.query, {
            num: Math.max(5, (input.num ?? 10) - (response.organic?.length ?? 0)),
            gl: input.gl,
            hl: input.hl,
            site
          });
          
          // Merge results, prioritizing document links
          const documentResults = response.organic ?? [];
          const generalResults = generalResponse.organic ?? [];
          
          // Combine and deduplicate
          const seenLinks = new Set<string>();
          const combined: typeof response.organic = [];
          
          // Add document results first
          for (const item of documentResults) {
            if (item.link && !seenLinks.has(item.link)) {
              seenLinks.add(item.link);
              combined.push(item);
            }
          }
          
          // Add general results that aren't duplicates
          for (const item of generalResults) {
            if (item.link && !seenLinks.has(item.link)) {
              seenLinks.add(item.link);
              combined.push(item);
            }
          }
          
          response = { ...response, organic: combined };
          logger.info({ 
            documentCount: documentResults.length,
            generalCount: generalResults.length,
            combinedCount: combined.length
          }, 'lovdata-serper: merged document and general search results');
        } catch (generalError) {
          logger.warn({ err: generalError }, 'lovdata-serper: general search fallback failed, using document results only');
        }
      }
    } else {
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
    }
    
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
      hl: candidate.hl,
      targetDocuments: candidate.targetDocuments
    };
  }

  throw new Error('Unsupported Serper skill input shape');
}

export const __test__ = {
  normalizeInput
};
