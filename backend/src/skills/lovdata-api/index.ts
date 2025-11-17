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
        pageSize
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
          const fallback = await services.serper.search(command.query, { num: 10 });
          fallbackInfo = {
            provider: 'serper',
            organic: (fallback.organic ?? []).map(item => ({
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
    return { action: 'searchPublicData', query: trimmed };
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
      return {
        action: 'searchPublicData',
        query: candidate.query.trim(),
        latest: candidate.latest,
        maxHits: candidate.maxHits,
        page: candidate.page,
        pageSize: candidate.pageSize
      };
    }
  }

  throw new Error('Unsupported Lovdata skill input shape');
}

export const __test__ = {
  normalizeInput
};
