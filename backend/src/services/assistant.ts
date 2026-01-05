import { performance } from 'node:perf_hooks';
import { getAgent } from '../agents/index.js';
import type { AgentEvidence, AgentOutputCitation, AgentOutput, AgentFunctionCall, AgentFunctionResult } from '../agents/types.js';
import { env } from '../config/env.js';
import { getServices } from './index.js';
import type { ServiceRegistry } from './index.js';
import { getOrchestrator } from '../skills/index.js';
import type { SkillOutput } from '../skills/skills-core.js';
import { logger } from '../logger.js';
import { withTrace } from '../observability/tracing.js';
import { lovdataSearchFunction } from '../skills/lovdata-api/functionSchema.js';
import { lovdataSerperFunction } from '../skills/lovdata-serper/functionSchema.js';
import { SerperClient } from './serperClient.js';

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
        scratch: {},
        agentCall: true // Flag to indicate this is an agent call
      } as const;

      // Prepare function definitions for the agent
      const functions = [
        {
          name: lovdataSearchFunction.name,
          description: lovdataSearchFunction.description,
          parameters: lovdataSearchFunction.parameters
        },
        {
          name: lovdataSerperFunction.name,
          description: lovdataSerperFunction.description,
          parameters: lovdataSerperFunction.parameters
        }
      ];

      logger.info('runAssistant: starting agent-driven function calling');
      
      // Agent-driven function calling loop
      let agentEvidence: AgentEvidence[] = [];
      let agentOutput: AgentOutput | undefined;
      let usedAgent = false;
      const maxAgentIterations = 5; // Prevent infinite loops
      const functionResults: AgentFunctionResult[] = [];
      
      // Get agent
      const agent = getAgent();
      if (!agent) {
        logger.warn('runAssistant: no agent available, cannot use function calling');
        // Fallback to empty results if no agent
        agentEvidence = [];
      } else {
        logger.info('runAssistant: agent available, starting function calling loop');
        
        for (let iteration = 0; iteration < maxAgentIterations; iteration++) {
          logger.info({ iteration: iteration + 1, maxIterations: maxAgentIterations }, 'runAssistant: agent iteration');
          
          try {
            // Call agent with current evidence and functions
            const agentInput = {
              question: options.question,
              evidence: agentEvidence,
              locale: options.locale,
              functions: functions,
              functionResults: functionResults.length > 0 ? functionResults : undefined
            };
            
            logger.info({
              evidenceCount: agentEvidence.length,
              functionResultsCount: functionResults.length,
              iteration: iteration + 1
            }, 'runAssistant: calling agent.generate');
            
            const agentResult = await agent.generate(agentInput);
            
            // Check if agent wants to call a function
            if (agentResult.functionCalls && agentResult.functionCalls.length > 0) {
              logger.info({
                functionCallsCount: agentResult.functionCalls.length,
                functionNames: agentResult.functionCalls.map(fc => fc.name)
              }, 'runAssistant: agent requested function calls');
              
              // Execute each function call
              for (const functionCall of agentResult.functionCalls) {
                try {
                  if (functionCall.name === 'search_lovdata_legal_documents') {
                    // Execute lovdata-api skill
                    const searchParams = JSON.parse(functionCall.arguments);
                    logger.info({ searchParams }, 'runAssistant: executing lovdata-api search');
                    
                    const skillResult = await orchestrator.run(
                      {
                        input: {
                          action: 'searchPublicData',
                          query: searchParams.query,
                          lawType: searchParams.lawType,
                          year: searchParams.year,
                          ministry: searchParams.ministry,
                          page: searchParams.page || page,
                          pageSize: searchParams.pageSize || pageSize
                        }
                      },
                      ctx
                    );
                    
                    // Convert skill results to evidence
                    // The skill returns: { result: { query, hits, searchedFiles, ... } }
                    // So skillResult.result already contains the hits array
                    logger.info({
                      skillResultType: typeof skillResult.result,
                      skillResultHasResult: !!skillResult.result,
                      skillResultKeys: skillResult.result ? Object.keys(skillResult.result) : [],
                      skillResultString: JSON.stringify(skillResult.result).substring(0, 500)
                    }, 'runAssistant: skill result structure');
                    
                    const lovdataResult = (skillResult.result ?? {}) as LovdataSkillSearchResult;
                    
                    logger.info({
                      lovdataResultKeys: Object.keys(lovdataResult),
                      hitsCount: lovdataResult.hits?.length ?? 0,
                      hitsIsArray: Array.isArray(lovdataResult.hits),
                      hitsSample: lovdataResult.hits?.[0] ? {
                        filename: lovdataResult.hits[0].filename,
                        member: lovdataResult.hits[0].member,
                        hasSnippet: !!lovdataResult.hits[0].snippet,
                        snippetLength: lovdataResult.hits[0].snippet?.length ?? 0
                      } : null
                    }, 'runAssistant: lovdata result structure');
                    
                    const newEvidence = convertLovdataSkillResultsToEvidence(lovdataResult.hits ?? []);
                    
                    logger.info({
                      newEvidenceCount: newEvidence.length,
                      evidenceSample: newEvidence[0] ? {
                        id: newEvidence[0].id,
                        source: newEvidence[0].source,
                        hasTitle: !!newEvidence[0].title,
                        hasSnippet: !!newEvidence[0].snippet
                      } : null
                    }, 'runAssistant: evidence conversion result');
                    
                    // Deduplicate evidence by (filename, member) to avoid duplicates
                    const existingKeys = new Set(agentEvidence.map(e => `${e.metadata?.filename}:${e.metadata?.member}`));
                    const uniqueNewEvidence = newEvidence.filter(e => {
                      const key = `${e.metadata?.filename}:${e.metadata?.member}`;
                      if (existingKeys.has(key)) {
                        return false;
                      }
                      existingKeys.add(key);
                      return true;
                    });
                    
                    agentEvidence = [...agentEvidence, ...uniqueNewEvidence];
                    
                    // Format function result with better guidance for agent
                    const formattedResult = {
                      ...lovdataResult,
                      _guidance: {
                        hitsFound: lovdataResult.hits?.length ?? 0,
                        totalHits: lovdataResult.totalHits ?? 0,
                        message: lovdataResult.hits && lovdataResult.hits.length > 0
                          ? `Found ${lovdataResult.hits.length} result(s). Use these to answer the user's question.`
                          : `No results found for this search. Consider trying a different law type, year, or broader search terms.`
                      }
                    };
                    
                    // Add to function results for next iteration
                    functionResults.push({
                      name: functionCall.name,
                      result: formattedResult,
                      toolCallId: functionCall.toolCallId
                    });
                    
                    logger.info({
                      hitsCount: lovdataResult.hits?.length ?? 0,
                      newEvidenceCount: newEvidence.length
                    }, 'runAssistant: lovdata-api search completed');
                    
                  } else if (functionCall.name === 'search_lovdata_legal_practice') {
                    // Execute lovdata-serper skill
                    const searchParams = JSON.parse(functionCall.arguments);
                    logger.info({ searchParams }, 'runAssistant: executing serper search');
                    
                    const skillResult = await orchestrator.run(
                      {
                        input: {
                          action: 'search',
                          query: searchParams.query,
                          num: searchParams.num || 10,
                          site: 'lovdata.no'
                        },
                        hints: { preferredSkill: 'lovdata-serper' }
                      },
                      ctx
                    );
                    
                    // Convert serper results to evidence
                    // The skill returns: { result: { query, site, organic } }
                    // So skillResult.result already contains the organic array
                    const serperResult = (skillResult.result ?? {}) as { 
                      query?: string;
                      site?: string;
                      organic?: Array<{ 
                        title?: string | null; 
                        link?: string | null; 
                        snippet?: string | null; 
                        date?: string | null;
                        isDocument?: boolean;
                      }> 
                    };
                    
                    logger.info({
                      skillResultType: typeof skillResult.result,
                      skillResultKeys: skillResult.result ? Object.keys(skillResult.result) : [],
                      serperResultKeys: Object.keys(serperResult),
                      organicCount: serperResult.organic?.length ?? 0,
                      organicIsArray: Array.isArray(serperResult.organic),
                      organicSample: serperResult.organic?.[0] ? {
                        title: serperResult.organic[0].title,
                        hasLink: !!serperResult.organic[0].link,
                        hasSnippet: !!serperResult.organic[0].snippet,
                        isDocument: serperResult.organic[0].isDocument
                      } : null
                    }, 'runAssistant: serper result structure');
                    
                    const newEvidence = convertSerperResultsToEvidence(serperResult.organic ?? []);
                    
                    logger.info({
                      newEvidenceCount: newEvidence.length,
                      evidenceSample: newEvidence[0] ? {
                        id: newEvidence[0].id,
                        source: newEvidence[0].source,
                        hasTitle: !!newEvidence[0].title,
                        hasLink: !!newEvidence[0].link
                      } : null
                    }, 'runAssistant: serper evidence conversion result');
                    
                    // Deduplicate evidence by link to avoid duplicates
                    const existingLinks = new Set(agentEvidence.map(e => e.link).filter(Boolean));
                    const uniqueNewEvidence = newEvidence.filter(e => {
                      if (!e.link || existingLinks.has(e.link)) {
                        return false;
                      }
                      existingLinks.add(e.link);
                      return true;
                    });
                    
                    agentEvidence = [...agentEvidence, ...uniqueNewEvidence];
                    
                    // Format function result with better guidance for agent
                    const organicResults = serperResult?.organic ?? [];
                    const formattedResult = {
                      ...serperResult,
                      _guidance: {
                        resultsFound: organicResults.length,
                        message: organicResults.length > 0
                          ? `Found ${organicResults.length} legal practice result(s). These provide practical examples and case law interpretations.`
                          : `No legal practice results found. The search focused on rettsavgjørelser, Lovtidend, Trygderetten, and related sources.`
                      }
                    };
                    
                    // Add to function results for next iteration
                    functionResults.push({
                      name: functionCall.name,
                      result: formattedResult,
                      toolCallId: functionCall.toolCallId
                    });
                    
                    logger.info({
                      organicCount: serperResult?.organic?.length ?? 0,
                      newEvidenceCount: newEvidence.length
                    }, 'runAssistant: serper search completed');
                  }
                } catch (functionError) {
                  logger.error({
                    err: functionError,
                    functionName: functionCall.name
                  }, 'runAssistant: function execution failed');
                  // Continue with other function calls
                }
              }
              
              // Continue loop to let agent process new evidence
              continue;
            } else {
              // Agent has final answer
              agentOutput = agentResult;
              usedAgent = true;
              logger.info('runAssistant: agent provided final answer');
              break;
            }
          } catch (agentError) {
            logger.error({
              err: agentError,
              iteration: iteration + 1
            }, 'runAssistant: agent iteration failed');
            // Break on error - will fall back to heuristic summary
            break;
          }
        }
        
        if (!agentOutput) {
          logger.warn('runAssistant: agent did not provide final answer after iterations');
        }
      }
      
      // Build result structure for compatibility with existing code
      const result: LovdataSkillSearchResult = {
        hits: [],
        searchedFiles: [],
        totalHits: agentEvidence.length,
        page: page,
        pageSize: pageSize,
        totalPages: Math.max(1, Math.ceil(agentEvidence.length / pageSize))
      };

      // Update links for HTML content
      const evidenceWithUpdatedLinks = await updateLinksForHtmlContent(agentEvidence, services);
      logger.info({ updatedCount: evidenceWithUpdatedLinks.length }, 'runAssistant: links updated');
      
      // Update agentEvidence with updated links
      agentEvidence = evidenceWithUpdatedLinks;

      const pagination = {
        page: result.page ?? page,
        pageSize: result.pageSize ?? pageSize,
        totalHits: result.totalHits ?? evidenceWithUpdatedLinks.length,
        totalPages: result.totalPages ?? Math.max(1, Math.ceil((result.totalHits ?? evidenceWithUpdatedLinks.length) / pageSize))
      };

      const combinedSkillMeta = undefined; // Not used in agent-driven flow

      logger.info({ usedAgent, hasAgentOutput: !!agentOutput }, 'runAssistant: building response');

      let response: AssistantRunResponse;
      if (usedAgent && agentOutput) {
        logger.info('runAssistant: building response with agent output');
        response = {
          answer: agentOutput.answer ?? 'Jeg klarte ikke å generere et svar.',
          evidence: evidenceWithUpdatedLinks,
          citations: normaliseCitations(agentOutput.citations ?? [], evidenceWithUpdatedLinks, pagination),
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
        const fallbackAnswer = buildFallbackAnswer(question, evidenceWithUpdatedLinks, null);
        response = {
          answer: fallbackAnswer,
          evidence: evidenceWithUpdatedLinks,
          citations: evidenceWithUpdatedLinks.map((item, index) => {
            const offset = (pagination.page - 1) * pagination.pageSize;
            return { evidenceId: item.id, label: `[${offset + index + 1}]` };
          }),
          pagination,
          metadata: {
            fallbackProvider: null,
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

  // Add overall timeout for all document fetches (50 seconds max for all items - leaves buffer for Vercel Pro 60s limit)
  const overallTimeoutMs = 50000;
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

  // Use Promise.allSettled to ensure we get results even if some fetches fail
  // This prevents one slow fetch from blocking all results
  const updatePromise = Promise.allSettled(
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

  // Race between Promise.allSettled and overall timeout
  // Use 50 seconds to avoid Vercel Pro timeout (60s limit)
  // This gives us time to complete before Vercel kills the function
  const reducedTimeoutMs = Math.min(overallTimeoutMs, 50000);
  const reducedTimeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      const elapsed = Date.now() - overallStartTime;
      logger.warn({
        elapsedMs: elapsed,
        evidenceCount: evidence.length,
        timeoutMs: reducedTimeoutMs
      }, 'updateLinksForHtmlContent: reduced timeout reached, returning partial results');
      reject(new Error(`updateLinksForHtmlContent timed out after ${reducedTimeoutMs}ms`));
    }, reducedTimeoutMs);
  });

  let results;
  try {
    logger.info('updateLinksForHtmlContent: awaiting all document fetches with overall timeout');
    const settledResults = await Promise.race([updatePromise, reducedTimeoutPromise]);

    // Extract results from settled promises
    results = settledResults.map((settled, index) => {
      if (settled.status === 'fulfilled') {
        return settled.value;
      } else {
        logger.warn({
          index,
          error: settled.reason,
          evidenceId: evidence[index]?.id
        }, 'updateLinksForHtmlContent: item processing failed, using original');
        return evidence[index]; // Return original item if processing failed
      }
    });

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
  const hydrationStartTime = Date.now();
  const hydrationTimeoutMs = 10000; // 10 seconds max for hydration - Vercel Pro allows 60s total

  logger.info({
    hasArchive: !!archiveStore,
    hasLovdata: !!lovdataClient,
    timeoutMs: hydrationTimeoutMs
  }, 'hydrateEvidenceContent: processing evidence items');

  const hydrationPromise = Promise.allSettled(
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

  // Add timeout to prevent hanging
  const hydrationTimeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      const elapsed = Date.now() - hydrationStartTime;
      logger.warn({
        elapsedMs: elapsed,
        evidenceCount: evidence.length,
        timeoutMs: hydrationTimeoutMs
      }, 'hydrateEvidenceContent: timeout reached, returning partial results');
      reject(new Error(`hydrateEvidenceContent timed out after ${hydrationTimeoutMs}ms`));
    }, hydrationTimeoutMs);
  });

  let settledResults;
  try {
    settledResults = await Promise.race([hydrationPromise, hydrationTimeoutPromise]);
  } catch (timeoutError) {
    // Timeout occurred - return evidence without full content
    logger.warn({
      err: timeoutError,
      evidenceCount: evidence.length
    }, 'hydrateEvidenceContent: timeout, returning evidence without full content');
    return evidence.map(item => ({ ...item, content: null }));
  }

  // Extract results from settled promises
  const results = settledResults.map((settled, index) => {
    if (settled.status === 'fulfilled') {
      return settled.value;
    } else {
      logger.warn({
        index,
        error: settled.reason,
        evidenceId: evidence[index]?.id
      }, 'hydrateEvidenceContent: item processing failed, using original without content');
      return { ...evidence[index], content: null }; // Return original item without content if processing failed
    }
  });

  const elapsed = Date.now() - hydrationStartTime;
  logger.info({
    processedCount: results.length,
    cacheSize: contentCache.size,
    elapsedMs: elapsed
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

// Helper function to convert lovdata-api skill results to evidence
function convertLovdataSkillResultsToEvidence(hits: Array<{
  filename: string;
  member: string;
  title?: string | null;
  date?: string | null;
  snippet: string;
}>): AgentEvidence[] {
  return hits.map((hit, index) => ({
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
  }));
}

// Helper function to convert serper skill results to evidence
// Only includes results with direct document links (filters out search pages and other non-document links)
function convertSerperResultsToEvidence(organic: Array<{
  title?: string | null;
  link?: string | null;
  snippet?: string | null;
  date?: string | null;
  isDocument?: boolean;
}>): AgentEvidence[] {
  let evidenceIndex = 0;
  
  return organic
    .filter((item) => {
      // Only include items with valid document links
      // Filter out search pages, list pages, and other non-document links
      if (!item.link) {
        logger.debug({
          title: item.title,
          reason: 'no_link'
        }, 'convertSerperResultsToEvidence: filtering out item with no link');
        return false;
      }
      
      // Check if it's a direct document link
      const isDocument = item.isDocument ?? SerperClient.isDocumentLink(item.link);
      
      if (!isDocument) {
        logger.debug({
          link: item.link,
          title: item.title,
          isDocument: item.isDocument
        }, 'convertSerperResultsToEvidence: filtering out non-document link');
        return false;
      }
      
      return true;
    })
    .map((item) => ({
      id: `serper-${++evidenceIndex}`,
      source: 'serper:lovdata.no',
      title: item.title ?? 'Uten tittel',
      snippet: item.snippet ?? null,
      date: item.date ?? null,
      link: item.link! // Safe to use ! here because we filtered out null links
    }));
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
    // In Vercel, all API routes must be under /api prefix
    // So the path should be /api/documents/xml, not /documents/xml
    const url = new URL('/api/documents/xml', env.PUBLIC_API_BASE_URL);
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
