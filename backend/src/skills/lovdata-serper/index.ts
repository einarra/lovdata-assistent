import type { SkillContext, SkillIO, SkillOutput } from '../skills-core.js';
import { SerperClient } from '../../services/serperClient.js';
import { env } from '../../config/env.js';

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
  const services = (ctx.services ?? {}) as Services;
  const client = services.serper;
  const input = normalizeInput(io.input);
  const site = input.site ?? env.SERPER_SITE_FILTER;
  if (!client) {
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

  const response = await client.search(input.query, {
    num: input.num,
    gl: input.gl,
    hl: input.hl,
    site
  });

  const organic = (response.organic ?? []).map(item => ({
    title: item.title ?? null,
    link: item.link ?? null,
    snippet: item.snippet ?? null,
    date: item.date ?? null
  }));

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
