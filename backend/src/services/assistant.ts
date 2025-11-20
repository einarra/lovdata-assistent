import { performance } from 'node:perf_hooks';
import { getAgent } from '../agents/index.js';
import type { AgentEvidence, AgentOutputCitation, AgentOutput } from '../agents/types.js';
import { env } from '../config/env.js';
import { getServices } from './index.js';
import type { ServiceRegistry } from './index.js';
import { getOrchestrator } from '../skills/index.js';
import type { SkillOutput } from '../skills/skills-core.js';
import { logger } from '../logger.js';
import { withTrace } from '../observability/tracing.js';

type AssistantPipelineResult = {
  response: AssistantRunResponse;
  usedAgent: boolean;
};

export type AssistantRunOptions = {
  question: string;
  locale?: string;
  page?: number;
  pageSize?: number;
};

export type AssistantRunResponse = {
  answer: string;
  evidence: AgentEvidence[];
  citations: AgentOutputCitation[];
  pagination: {
    page: number;
    pageSize: number;
    totalHits: number;
    totalPages: number;
  };
  metadata: {
    fallbackProvider?: string | null;
    skillMeta?: Record<string, unknown>;
    agentModel?: string | null;
    usedAgent: boolean;
    traceRunId?: string | null;
    skillRunId?: string | null;
    agentRunId?: string | null;
    generatedAt: string;
    processingTimeMs: number;
  };
};

const DEFAULT_PAGE_SIZE = 5;
const DEFAULT_LATEST_ARCHIVES = 3;
const DEFAULT_MAX_HITS = 200;
const AGENT_MAX_EVIDENCE_ITEMS = 6;
const AGENT_MAX_CONTENT_CHARS = 20000;

export async function runAssistant(options: AssistantRunOptions, _userContext?: { userId: string }): Promise<AssistantRunResponse> {
  const started = performance.now();
  const question = options.question.trim();
  const page = options.page && options.page > 0 ? Math.floor(options.page) : 1;
  const pageSize = options.pageSize && options.pageSize > 0 ? Math.min(Math.floor(options.pageSize), 20) : DEFAULT_PAGE_SIZE;

  logger.info({ question, page, pageSize }, 'runAssistant: starting');

  const { result: pipeline } = await withTrace<AssistantPipelineResult>(
    {
      name: 'assistant.run',
      runType: 'chain',
      inputs: { question, page, pageSize },
      tags: ['assistant'],
      getOutputs: (result: AssistantPipelineResult) => ({
        answer: result.response.answer,
        usedAgent: result.usedAgent
      })
    },
    async () => {
      logger.info('runAssistant: getting orchestrator and services');
      const orchestrator = await getOrchestrator();
      const services = getServices();
      logger.info({ 
        hasArchive: !!services.archive,
        hasLovdata: !!services.lovdata,
        hasSerper: !!services.serper
      }, 'runAssistant: services obtained');
      
      const ctx = {
        now: new Date(),
        locale: options.locale,
        services,
        scratch: {}
      } as const;

      logger.info('runAssistant: calling skill.searchPublicData');
      let skillOutput: any;
      try {
        // Add overall timeout for the entire skill execution (25 seconds)
        const skillTimeoutMs = 25000;
        const skillTimeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Skill execution timed out after ${skillTimeoutMs}ms`));
          }, skillTimeoutMs);
        });
        
        const skillExecutionPromise = withTrace(
          {
            name: 'skill.searchPublicData',
            runType: 'tool',
            inputs: {
              action: 'searchPublicData',
              query: question,
              page,
              pageSize
            },
            tags: ['skill', 'lovdata'],
            getOutputs: (output: any) => ({
              hits: Array.isArray((output.result as LovdataSkillSearchResult)?.hits)
                ? (output.result as LovdataSkillSearchResult).hits?.length
                : undefined
            })
          },
          async () => {
            logger.info('runAssistant: calling orchestrator.run');
            const result = await orchestrator.run(
              {
                input: {
                  action: 'searchPublicData',
                  query: question,
                  latest: DEFAULT_LATEST_ARCHIVES,
                  maxHits: DEFAULT_MAX_HITS,
                  page,
                  pageSize
                }
              },
              ctx
            );
            logger.info({ 
              hasResult: !!result,
              resultType: typeof result,
              resultKeys: result && typeof result === 'object' ? Object.keys(result) : []
            }, 'runAssistant: orchestrator.run completed');
            return result;
          }
        );
        
        const traceResult = await Promise.race([skillExecutionPromise, skillTimeoutPromise]);
        skillOutput = traceResult;
        logger.info('runAssistant: skill.searchPublicData trace completed');
      } catch (skillError) {
        logger.error({ 
          err: skillError,
          stack: skillError instanceof Error ? skillError.stack : undefined
        }, 'runAssistant: skill.searchPublicData failed');
        
        // If skill execution fails or times out, continue with empty results
        // This allows the assistant to still provide a response
        logger.warn('runAssistant: continuing with empty results due to skill failure');
        skillOutput = {
          result: {
            hits: [],
            searchedFiles: [],
            totalHits: 0,
            page: 1,
            pageSize: 5,
            totalPages: 0
          },
          meta: {
            skill: 'lovdata-api',
            action: 'searchPublicData',
            error: skillError instanceof Error ? skillError.message : String(skillError)
          }
        };
      }
      
      // skillOutput is { result: SkillOutput, runId: string } from withTrace
      // SkillOutput has { result: any, meta?: any }
      const skillOutputData = skillOutput.result;
      logger.info({ 
        hasResult: !!skillOutputData,
        resultType: typeof skillOutputData,
        hasResultField: skillOutputData && typeof skillOutputData === 'object' && 'result' in skillOutputData,
        resultKeys: skillOutputData && typeof skillOutputData === 'object' ? Object.keys(skillOutputData) : []
      }, 'runAssistant: extracted skill result');

      // Extract the actual result from SkillOutput
      const result = (skillOutputData?.result ?? {}) as LovdataSkillSearchResult;
      logger.info({ 
        hasHits: Array.isArray(result.hits),
        hitsCount: Array.isArray(result.hits) ? result.hits.length : 0,
        resultKeys: result && typeof result === 'object' ? Object.keys(result) : []
      }, 'runAssistant: processed skill result');
      let serperSkillMeta: Record<string, unknown> | undefined;

      const primaryHits = Array.isArray(result.hits) ? result.hits.length : 0;

      // Always run Serper when available to include both Lovdata and web results
      // TEMPORARILY DISABLED FOR TESTING - Serper is causing timeouts
      const ENABLE_SERPER = false; // Set to true to re-enable Serper
      if (ENABLE_SERPER && services.serper) {
        logger.info({ question, hasSerper: !!services.serper }, 'runAssistant: starting Serper skill execution');
        try {
          logger.info('runAssistant: calling Serper orchestrator.run');
          const { result: serperSkillOutput } = await withTrace<SkillOutput>(
            {
              name: 'skill.serperSearch',
              runType: 'tool',
              inputs: {
                action: 'search',
                query: question
              },
              tags: ['skill', 'serper'],
              getOutputs: (output: SkillOutput) => {
                const organicCount = Array.isArray((output.result as any)?.organic)
                  ? (output.result as any).organic.length
                  : undefined;
                return { organicCount };
              }
            },
            async () =>
              orchestrator.run(
                {
                  input: {
                    action: 'search',
                    query: question,
                    site: env.SERPER_SITE_FILTER ?? 'lovdata.no'
                  },
                  hints: { preferredSkill: 'lovdata-serper' }
                },
                ctx
              )
          );
          
          logger.info({ 
            hasResult: !!serperSkillOutput,
            resultType: typeof serperSkillOutput
          }, 'runAssistant: Serper orchestrator.run completed');

          const serperResult = (serperSkillOutput.result ?? {}) as {
            organic?: Array<{
              title?: string | null;
              link?: string | null;
              snippet?: string | null;
              date?: string | null;
            }>;
            site?: string | null;
          };

          const organicResults = Array.isArray(serperResult.organic) ? serperResult.organic : [];
          if (organicResults.length > 0) {
            const providerLabel = serperResult.site ? `serper:${serperResult.site}` : 'serper';
            const existingFallbackOrganic = Array.isArray(result.fallback?.organic) ? result.fallback!.organic : [];
            const dedupedOrganic: Array<{
              title: string | null;
              link: string | null;
              snippet: string | null;
              date: string | null;
            }> = [];
            const seenKeys = new Set<string>();

            const pushIfNew = (item: { title: string | null; link: string | null; snippet: string | null; date: string | null }) => {
              const key = (item.link ?? item.title ?? '').toLowerCase();
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                dedupedOrganic.push(item);
              }
            };

            for (const existing of existingFallbackOrganic) {
              pushIfNew({
                title: existing.title ?? null,
                link: existing.link ?? null,
                snippet: existing.snippet ?? null,
                date: existing.date ?? null
              });
            }

            for (const fresh of organicResults) {
              pushIfNew({
                title: fresh.title ?? null,
                link: fresh.link ?? null,
                snippet: fresh.snippet ?? null,
                date: fresh.date ?? null
              });
            }

            const providerParts = [
              ...(result.fallback?.provider ? result.fallback.provider.split(/\s*\|\s*/) : []),
              providerLabel
            ].filter(Boolean);
            const providerCombined = Array.from(new Set(providerParts)).join(' | ');

            result.fallback = {
              provider: providerCombined || providerLabel,
              organic: dedupedOrganic
            };

            serperSkillMeta =
              serperSkillOutput.meta ??
              ({
                site: serperResult.site ?? null,
                organicResults: organicResults.length
              } as Record<string, unknown>);
            logger.info({ 
              organicResultsCount: organicResults.length,
              providerCombined
            }, 'runAssistant: Serper results processed');
          } else {
            logger.info('runAssistant: Serper returned no organic results');
          }
        } catch (error) {
          logger.error({ err: error, stack: error instanceof Error ? error.stack : undefined }, 'Serper skill execution failed');
        }
        logger.info('runAssistant: Serper skill execution completed');
      } else {
        if (!ENABLE_SERPER) {
          logger.info('runAssistant: Serper skill disabled for testing');
        } else {
          logger.info('runAssistant: Serper service not available, skipping');
        }
      }

      logger.info('runAssistant: building evidence');
      const evidence = buildEvidence(result);
      logger.info({ evidenceCount: evidence.length }, 'runAssistant: evidence built');
      
      // Always update links for HTML content, regardless of agent usage
      logger.info('runAssistant: updating links for HTML content');
      const evidenceWithUpdatedLinks = await updateLinksForHtmlContent(evidence, services);
      logger.info({ updatedCount: evidenceWithUpdatedLinks.length }, 'runAssistant: links updated');
      
      let agentEvidence: AgentEvidence[] = evidenceWithUpdatedLinks;
      const pagination = {
        page: result.page ?? page,
        pageSize: result.pageSize ?? pageSize,
        totalHits: result.totalHits ?? evidenceWithUpdatedLinks.length,
        totalPages: result.totalPages ?? Math.max(1, Math.ceil((result.totalHits ?? evidenceWithUpdatedLinks.length) / pageSize))
      };

      const combinedSkillMeta =
        skillOutput.meta || serperSkillMeta
          ? {
              ...(skillOutput.meta ?? {}),
              ...(serperSkillMeta ? { serper: serperSkillMeta } : {})
            }
          : undefined;

      logger.info('runAssistant: getting agent');
      const agent = getAgent();
      logger.info({ hasAgent: !!agent }, 'runAssistant: agent obtained');
      
      let agentOutput: AgentOutput | undefined;
      let usedAgent = false;

      if (agent && evidenceWithUpdatedLinks.length > 0) {
        logger.info({ evidenceCount: evidenceWithUpdatedLinks.length }, 'runAssistant: hydrating evidence content for agent');
        agentEvidence = limitAgentEvidence(await hydrateEvidenceContent(evidenceWithUpdatedLinks, services));
        logger.info({ hydratedCount: agentEvidence.length }, 'runAssistant: evidence content hydrated');
        try {
          const traceEvidenceSample = agentEvidence.slice(0, Math.min(agentEvidence.length, 5)).map(item => ({
            id: item.id,
            source: item.source,
            title: item.title,
            snippet: item.snippet
          }));

          logger.info({ 
            question,
            evidenceCount: agentEvidence.length,
            sampleCount: traceEvidenceSample.length
          }, 'runAssistant: calling OpenAI agent');
          
          // Check if we've already used too much time - if so, skip OpenAI and use fallback
          // We've already used ~3.5s (database timeout + Serper), so ALWAYS skip OpenAI
          // The timeout mechanism isn't reliable in Vercel, and OpenAI calls are consistently
          // causing the function to be killed. Skip proactively to ensure we can return a response.
          const timeUsedSoFar = performance.now() - started;
          const maxTimeForOpenAI = 3300; // 3.3 seconds max - always skip OpenAI after database timeout
          if (timeUsedSoFar > maxTimeForOpenAI) {
            logger.warn({ 
              timeUsedSoFar: Math.round(timeUsedSoFar),
              maxTimeForOpenAI 
            }, 'runAssistant: skipping OpenAI call - too much time already used, using fallback');
            // Skip OpenAI call and use fallback (agentOutput will remain undefined)
          } else {
            logger.info({ 
              timeUsedSoFar: Math.round(timeUsedSoFar),
              maxTimeForOpenAI 
            }, 'runAssistant: proceeding with OpenAI call - time check passed');
            const agentCall = await withTrace<AgentOutput>(
            {
              name: 'agent.answer',
              runType: 'llm',
              inputs: {
                question,
                evidence: traceEvidenceSample
              },
              tags: ['assistant', 'openai'],
              getOutputs: (output: AgentOutput) => ({ answer: output.answer })
            },
            async () => {
              logger.info('runAssistant: calling agent.generate');
              const result = await agent.generate({ question, evidence: agentEvidence, locale: options.locale });
              logger.info({ 
                answerLength: result.answer.length,
                citationsCount: result.citations.length,
                model: result.model
              }, 'runAssistant: agent.generate completed');
              return result;
            }
          );

            agentOutput = agentCall.result;
            usedAgent = true;
            logger.info('runAssistant: agent output obtained');
          }
        } catch (error) {
          logger.error({ err: error }, 'OpenAI agent failed; falling back to heuristic summary');
        }
      }

      logger.info({ usedAgent, hasAgentOutput: !!agentOutput }, 'runAssistant: building response');
      
      let response: AssistantRunResponse;
      if (usedAgent && agentOutput) {
        logger.info('runAssistant: building response with agent output');
        response = {
          answer: agentOutput.answer,
          evidence: evidenceWithUpdatedLinks,
          citations: normaliseCitations(agentOutput.citations, evidenceWithUpdatedLinks, pagination),
          pagination,
          metadata: {
            fallbackProvider: result.fallback?.provider ?? null,
            skillMeta: combinedSkillMeta,
            agentModel: agentOutput.model ?? env.OPENAI_MODEL,
            usedAgent: true,
            generatedAt: new Date().toISOString(),
            processingTimeMs: 0
          }
        };
        logger.info({ 
          answerLength: response.answer.length,
          evidenceCount: response.evidence.length,
          citationsCount: response.citations.length
        }, 'runAssistant: response built with agent output');
      } else {
        logger.info('runAssistant: building fallback response');
        const fallbackAnswer = buildFallbackAnswer(question, evidenceWithUpdatedLinks, result.fallback?.provider ?? null);
        response = {
          answer: fallbackAnswer,
          evidence: evidenceWithUpdatedLinks,
          citations: evidenceWithUpdatedLinks.map((item, index) => {
            const offset = (pagination.page - 1) * pagination.pageSize;
            return { evidenceId: item.id, label: `[${offset + index + 1}]` };
          }),
          pagination,
          metadata: {
            fallbackProvider: result.fallback?.provider ?? null,
            skillMeta: combinedSkillMeta,
            agentModel: null,
            usedAgent: false,
            generatedAt: new Date().toISOString(),
            processingTimeMs: 0
          }
        };
        logger.info({ 
          answerLength: response.answer.length,
          evidenceCount: response.evidence.length,
          citationsCount: response.citations.length
        }, 'runAssistant: fallback response built');
      }
      
      logger.info('runAssistant: response prepared, returning');

      const pipelineResult: AssistantPipelineResult = {
        response,
        usedAgent
      };
      return pipelineResult;
    }
  );

  const finalResponse = pipeline.response;
  finalResponse.metadata.processingTimeMs = Math.round(performance.now() - started);
  finalResponse.metadata.traceRunId = null;
  finalResponse.metadata.skillRunId = null;
  finalResponse.metadata.agentRunId = null;

  return finalResponse;
}

type LovdataSkillSearchResult = {
  hits?: Array<{
    filename: string;
    member: string;
    title?: string | null;
    date?: string | null;
    snippet: string;
  }>;
  searchedFiles?: string[];
  fallback?: {
    provider: string;
    organic?: Array<{
      title?: string | null;
      link?: string | null;
      snippet?: string | null;
      date?: string | null;
    }>;
  };
  page?: number;
  pageSize?: number;
  totalHits?: number;
  totalPages?: number;
};

function isHtmlContent(text: string): boolean {
  if (!text) {
    return false;
  }
  const snippet = text.slice(0, 1000).toLowerCase();
  return snippet.includes('<html') || snippet.includes('<!doctype html');
}

async function updateLinksForHtmlContent(evidence: AgentEvidence[], services: ServiceRegistry): Promise<AgentEvidence[]> {
  logger.info({ evidenceCount: evidence.length }, 'updateLinksForHtmlContent: starting');
  
  const lovdataClient = services.lovdata;
  const archiveStore = services.archive ?? null;
  if (!lovdataClient && !archiveStore) {
    logger.info('updateLinksForHtmlContent: no services available, returning evidence as-is');
    return evidence;
  }

  logger.info({ 
    hasArchive: !!archiveStore,
    hasLovdata: !!lovdataClient
  }, 'updateLinksForHtmlContent: processing evidence items');

  // Add timeout for each document fetch (5 seconds per item)
  const documentFetchTimeoutMs = 5000;
  const overallStartTime = Date.now();
  
  // Add overall timeout for all document fetches (30 seconds max for all items)
  const overallTimeoutMs = 30000;
  const overallTimeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      const elapsed = Date.now() - overallStartTime;
      logger.error({ 
        elapsedMs: elapsed, 
        evidenceCount: evidence.length,
        timeoutMs: overallTimeoutMs 
      }, 'updateLinksForHtmlContent: overall timeout reached');
      reject(new Error(`updateLinksForHtmlContent timed out after ${overallTimeoutMs}ms`));
    }, overallTimeoutMs);
  });
  
  const updatePromise = Promise.all(
    evidence.map(async (item, index) => {
      logger.debug({ index, evidenceId: item.id }, 'updateLinksForHtmlContent: processing item');
      
      const metadata = item.metadata ?? {};
      const filename = typeof metadata.filename === 'string' ? metadata.filename : undefined;
      const member = typeof metadata.member === 'string' ? metadata.member : undefined;

      // Only update lovdata source items
      if (item.source !== 'lovdata' || !filename || !member) {
        return item;
      }

      // Skip if already .html
      if (member.toLowerCase().endsWith('.html')) {
        return item;
      }

      try {
        // Check if content is HTML with timeout
        let fullText: string | null = null;
        
        const fetchPromise = (async () => {
          if (archiveStore) {
            logger.debug({ filename, member }, 'updateLinksForHtmlContent: fetching from archive store');
            return await archiveStore.getDocumentContentAsync(filename, member);
          }
          if (lovdataClient) {
            logger.debug({ filename, member }, 'updateLinksForHtmlContent: fetching from lovdata client');
            const result = await lovdataClient.extractXml(filename, member);
            return result.text;
          }
          return null;
        })();
        
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Document fetch timed out after ${documentFetchTimeoutMs}ms for ${filename}/${member}`));
          }, documentFetchTimeoutMs);
        });
        
        try {
          fullText = await Promise.race([fetchPromise, timeoutPromise]);
          logger.debug({ filename, member, hasText: !!fullText, textLength: fullText?.length ?? 0 }, 'updateLinksForHtmlContent: document fetched');
        } catch (fetchError) {
          logger.warn({ 
            err: fetchError,
            filename,
            member,
            evidenceId: item.id
          }, 'updateLinksForHtmlContent: document fetch failed or timed out, skipping HTML check');
          // Continue without updating the link if fetch fails
          return item;
        }

        if (fullText && isHtmlContent(fullText) && member.toLowerCase().endsWith('.xml')) {
          // Update link to use .html extension - endpoint will handle the fallback to .xml
          const htmlMember = member.replace(/\.xml$/i, '.html');
          const updatedLink = buildXmlViewerUrl(filename, htmlMember);
          const updatedMetadata = { ...metadata };
          updatedMetadata.fileExtension = '.html';
          updatedMetadata.member = htmlMember;

          logger.debug({ filename, member, htmlMember }, 'updateLinksForHtmlContent: updated link to HTML');
          return {
            ...item,
            link: updatedLink,
            metadata: updatedMetadata
          };
        }
      } catch (error) {
        logger.warn({ 
          err: error,
          stack: error instanceof Error ? error.stack : undefined,
          filename, 
          member, 
          evidenceId: item.id 
        }, 'updateLinksForHtmlContent: error updating link for HTML content');
      }

      return item;
    })
  );
  
  // Race between Promise.all and overall timeout
  let results;
  try {
    logger.info('updateLinksForHtmlContent: awaiting all document fetches with overall timeout');
    results = await Promise.race([updatePromise, overallTimeoutPromise]);
    const elapsed = Date.now() - overallStartTime;
    logger.info({ 
      processedCount: results.length,
      inputCount: evidence.length,
      elapsedMs: elapsed
    }, 'updateLinksForHtmlContent: completed');
  } catch (overallError) {
    const elapsed = Date.now() - overallStartTime;
    logger.error({ 
      err: overallError,
      elapsedMs: elapsed,
      evidenceCount: evidence.length
    }, 'updateLinksForHtmlContent: overall timeout or error, returning evidence as-is');
    // Return evidence without HTML link updates if overall timeout occurs
    return evidence;
  }
  
  return results;
}

async function hydrateEvidenceContent(evidence: AgentEvidence[], services: ServiceRegistry): Promise<AgentEvidence[]> {
  logger.info({ evidenceCount: evidence.length }, 'hydrateEvidenceContent: starting');
  
  const lovdataClient = services.lovdata;
  const archiveStore = services.archive ?? null;
  if (!lovdataClient && !archiveStore) {
    logger.info('hydrateEvidenceContent: no services available, returning evidence as-is');
    return evidence;
  }

  const contentCache = new Map<string, string>();
  
  logger.info({ 
    hasArchive: !!archiveStore,
    hasLovdata: !!lovdataClient
  }, 'hydrateEvidenceContent: processing evidence items');

  const results = await Promise.all(
    evidence.map(async (item, index) => {
      logger.debug({ index, evidenceId: item.id }, 'hydrateEvidenceContent: processing item');
      const metadata = item.metadata ?? {};
      const filename = typeof metadata.filename === 'string' ? metadata.filename : undefined;
      const member = typeof metadata.member === 'string' ? metadata.member : undefined;

      if (!filename || !member) {
        return item;
      }

      try {
        // If member ends in .html, fall back to .xml for fetching
        // This allows links to show .html extension while still fetching the actual .xml file
        let actualMember = member;
        let preFetchedText: string | null = null;
        if (member.toLowerCase().endsWith('.html')) {
          const xmlMember = member.replace(/\.html$/i, '.xml');
          // Try .xml version first since that's what's actually in the archive
          if (archiveStore) {
            const testContent = await archiveStore.getDocumentContentAsync(filename, xmlMember);
            if (testContent) {
              actualMember = xmlMember;
              preFetchedText = testContent;
            }
          } else if (lovdataClient) {
            // If no archive store, try to verify .xml exists via lovdata API
            try {
              const result = await lovdataClient.extractXml(filename, xmlMember);
              actualMember = xmlMember;
              preFetchedText = result.text;
            } catch {
              // Keep .html if .xml doesn't exist (unlikely but handle gracefully)
            }
          }
        }

        const cacheKey = `${filename}::${actualMember}`;
        let fullText: string | null = preFetchedText;
        
        // Get full text to check content type and cache truncated version
        if (!fullText) {
          if (archiveStore) {
            fullText = await archiveStore.getDocumentContentAsync(filename, actualMember);
          }
          if (!fullText && lovdataClient) {
            const result = await lovdataClient.extractXml(filename, actualMember);
            fullText = result.text;
          }
        }
        
        if (fullText && !contentCache.has(cacheKey)) {
          contentCache.set(cacheKey, truncateContent(fullText));
        }

        // If content is HTML but member name ends in .xml, update link and metadata to reflect .html
        // The endpoint will handle .html in the member parameter by falling back to .xml for fetching
        const updatedMetadata = { ...metadata };
        let updatedLink = item.link;
        if (fullText && isHtmlContent(fullText) && member.toLowerCase().endsWith('.xml')) {
          updatedMetadata.fileExtension = '.html';
          // Update member name in metadata to show .html extension
          const htmlMember = member.replace(/\.xml$/i, '.html');
          updatedMetadata.member = htmlMember;
          // Update link to use .html extension - endpoint will handle the fallback to .xml
          updatedLink = buildXmlViewerUrl(filename, htmlMember);
        }

        return {
          ...item,
          content: contentCache.get(cacheKey) ?? null,
          link: updatedLink,
          metadata: updatedMetadata
        };
      } catch (error) {
        logger.warn({ err: error, filename, member, evidenceId: item.id }, 'Failed to hydrate evidence content');
        return item;
      }
    })
  );
  
  logger.info({ 
    processedCount: results.length,
    cacheSize: contentCache.size
  }, 'hydrateEvidenceContent: completed');
  
  return results;
}

function limitAgentEvidence(items: AgentEvidence[]): AgentEvidence[] {
  if (items.length <= AGENT_MAX_EVIDENCE_ITEMS) {
    return items;
  }
  return items.slice(0, AGENT_MAX_EVIDENCE_ITEMS);
}

function truncateContent(text: string): string {
  if (text.length <= AGENT_MAX_CONTENT_CHARS) {
    return text;
  }
  const headLimit = Math.max(AGENT_MAX_CONTENT_CHARS - 1000, 0);
  const head = headLimit > 0 ? text.slice(0, headLimit).trimEnd() : '';
  const tail = text.slice(-1000).trimStart();
  if (!head) {
    return `${tail}`;
  }
  return `${head}\n...\n${tail}`;
}

function buildEvidence(result: LovdataSkillSearchResult): AgentEvidence[] {
  const evidence: AgentEvidence[] = [];

  (result.hits ?? []).forEach((hit, index) => {
    evidence.push({
      id: `lovdata-${index + 1}`,
      source: 'lovdata',
      title: hit.title ?? hit.filename ?? 'Uten tittel',
      snippet: hit.snippet,
      date: hit.date ?? null,
      link: buildXmlViewerUrl(hit.filename, hit.member),
      metadata: {
        filename: hit.filename,
        member: hit.member
      }
    });
  });

  (result.fallback?.organic ?? []).forEach((item, index) => {
    evidence.push({
      id: `fallback-${index + 1}`,
      source: result.fallback?.provider ?? 'web',
      title: item.title ?? 'Uten tittel',
      snippet: item.snippet ?? null,
      date: item.date ?? null,
      link: item.link ?? null
    });
  });

  return evidence;
}

function normaliseCitations(
  citations: AgentOutputCitation[], 
  evidence: AgentEvidence[], 
  pagination: { page: number; pageSize: number }
): AgentOutputCitation[] {
  // Calculate offset based on pagination
  const offset = (pagination.page - 1) * pagination.pageSize;
  
  // Create a map of evidence ID to its sequential position in the full list
  const evidenceIndexMap = new Map(
    evidence.map((item, index) => [item.id, offset + index + 1])
  );

  if (!citations || citations.length === 0) {
    // No citations from agent - create default citations with correct sequential numbering
    return evidence.map((item, index) => ({ 
      evidenceId: item.id, 
      label: `[${offset + index + 1}]` 
    }));
  }

  // Filter valid citations and ALWAYS recalculate labels based on actual position
  const evidenceIds = new Set(evidence.map(item => item.id));
  return citations
    .filter(citation => evidenceIds.has(citation.evidenceId))
    .flatMap(citation => {
      const position = evidenceIndexMap.get(citation.evidenceId);
      if (!position) {
        // Should not happen after filter, but handle gracefully
        return [];
      }
      return [{
        evidenceId: citation.evidenceId,
        // Always use the calculated position, ignoring agent's label
        label: `[${position}]`,
        quote: citation.quote
      }];
    });
}

function buildFallbackAnswer(question: string, evidence: AgentEvidence[], provider: string | null): string {
  if (evidence.length === 0) {
    if (provider) {
      return `Jeg fant ingen direkte treff i Lovdatas offentlige data, men fikk resultater via ${provider}. Se kildeoversikten under.`;
    }
    return 'Jeg fant ingen relevante dokumenter. Vurder å formulere spørsmålet på en annen måte eller begrense søket.';
  }

  const intro = 'Her er en oppsummering basert på tilgjengelige dokumenter:';
  const bullets = evidence.slice(0, 5).map(item => `- ${item.title ?? 'Uten tittel'}${item.source === 'lovdata' ? ' (Lovdata)' : ''}`);
  return `${intro}\n${bullets.join('\n')}`;
}

function buildXmlViewerUrl(
  filename: string | undefined,
  member: string | undefined,
  options?: { format?: 'markdown' | 'json' | string }
): string | null {
  if (!filename || !member) {
    return null;
  }

  try {
    const url = new URL('/documents/xml', env.PUBLIC_API_BASE_URL);
    url.searchParams.set('filename', filename);
    url.searchParams.set('member', member);
    if (options?.format) {
      url.searchParams.set('format', options.format);
    }
    return url.toString();
  } catch (error) {
    logger.error({ err: error, filename, member }, 'Failed to build XML viewer URL');
    return null;
  }
}
