import type { SkillContext, SkillIO, SkillOutput } from '../skills-core.js';
import { SerperClient } from '../../services/serperClient.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';

// Register sites for different document types
const REGISTER_SITES = {
  lov: 'https://lovdata.no/register/lover',
  forskrift: 'https://lovdata.no/register/forskrifter',
  avgjørelse: 'https://lovdata.no/register/avgjørelser',
  kunngjøring: 'https://lovdata.no/register/lovtidend'
} as const;

type DocumentType = keyof typeof REGISTER_SITES;

type SerperSkillInput = {
  action?: 'search';
  query: string;
  documentType?: DocumentType;
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
  
  // Determine which register site to use based on documentType
  // Default to 'avgjørelse' for agent calls to prioritize rettsavgjørelser
  const isAgentCall = (ctx as any).agentCall === true;
  const documentType: DocumentType = input.documentType ?? (isAgentCall ? 'avgjørelse' : 'lov');
  const registerSite = REGISTER_SITES[documentType];
  
  logger.info({ 
    hasClient: !!client,
    query: input.query,
    documentType,
    registerSite,
    hasApiKey: !!env.SERPER_API_KEY,
    isAgentCall
  }, 'lovdata-serper: checking client configuration');
  
  if (!client) {
    logger.warn('lovdata-serper: client not available, returning unconfigured message');
    return {
      result: {
        message: 'Serper API-nøkkel er ikke konfigurert. Sett SERPER_API_KEY for å aktivere nettsøk.',
        query: input.query,
        documentType,
        registerSite
      },
      meta: {
        skill: 'lovdata-serper',
        action: 'search',
        configured: false
      }
    };
  }
  
  // Map documentType to specific inurl patterns for document links
  // Instead of searching on register pages (which return search pages), 
  // we search on lovdata.no with specific document URL patterns
  const documentTypePatterns: Record<DocumentType, string[]> = {
    lov: ['/dokument/', '/lov/', '/lover/'],
    forskrift: ['/dokument/', '/forskrift/', '/forskrifter/'],
    avgjørelse: ['/dokument/', '/avgjørelser/', '/avgjorelse/'],
    kunngjøring: ['/dokument/', '/lovtidend/']
  };
  
  const patternsForType = documentType ? documentTypePatterns[documentType] : documentTypePatterns.avgjørelse;
  
  logger.info({ 
    query: input.query, 
    documentType,
    registerSite,
    patternsForType,
    searchStrategy: 'lovdata.no with document patterns'
  }, 'lovdata-serper: calling client.search with document patterns');
  
  let response;
  try {
    // Search on lovdata.no (not register pages) with targetDocuments to get actual document links
    // This ensures we get links to documents, not search/register pages
    response = await client.search(input.query, {
      num: input.num,
      gl: input.gl ?? 'no',
      hl: input.hl ?? 'no',
      site: 'lovdata.no',
      targetDocuments: true, // This will use inurl patterns to find document links
      documentTypePatterns: patternsForType // Prioritize specific patterns for this document type
    });
    
    logger.info({ 
      hasOrganic: !!response.organic,
      organicCount: Array.isArray(response.organic) ? response.organic.length : 0,
      documentType,
      registerSite
    }, 'lovdata-serper: client.search completed');
    
    // Prioritize document links in results
    response = SerperClient.prioritizeDocumentLinks(response);
  } catch (searchError) {
    logger.error({ 
      err: searchError,
      stack: searchError instanceof Error ? searchError.stack : undefined,
      documentType,
      registerSite
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
    organicCount: organic.length,
    documentType,
    registerSite
  }, 'lovdata-serper: processing results');

  return {
    result: {
      query: input.query,
      documentType,
      registerSite,
      organic
    },
    meta: {
      skill: 'lovdata-serper',
      action: 'search',
      documentType,
      totalOrganicResults: organic.length
    }
  };
}

function normalizeInput(input: unknown): SerperSkillInput {
  if (typeof input === 'string') {
    return { action: 'search', query: input.trim() };
  }

  if (input && typeof input === 'object') {
    const candidate = input as Partial<SerperSkillInput> & { query?: unknown; documentType?: unknown };
    if (!candidate.query || typeof candidate.query !== 'string') {
      throw new Error('Serper skill requires a string query');
    }
    
    // Validate documentType if provided
    let documentType: DocumentType | undefined;
    if (candidate.documentType) {
      if (typeof candidate.documentType === 'string' && candidate.documentType in REGISTER_SITES) {
        documentType = candidate.documentType as DocumentType;
      } else {
        logger.warn({ 
          providedDocumentType: candidate.documentType 
        }, 'lovdata-serper: invalid documentType, ignoring');
      }
    }
    
    return {
      action: 'search',
      query: candidate.query.trim(),
      documentType,
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
