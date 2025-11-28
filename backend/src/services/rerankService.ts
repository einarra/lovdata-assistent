/**
 * Re-ranking service for improving search result relevance.
 * 
 * This service uses Cohere Rerank API to re-order search results based on
 * semantic relevance to the query. This improves upon basic term-frequency
 * ranking by understanding the meaning of the query and documents.
 * 
 * Usage:
 * 1. Retrieve larger candidate set from hybrid search (e.g., Top 50)
 * 2. Re-rank candidates using this service
 * 3. Return top N re-ranked results (e.g., Top 5-10)
 */

import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger.js';
import { Timer } from '../utils/timing.js';
import { env } from '../config/env.js';

export interface RerankOptions {
  logger?: Logger;
  model?: string;
  topN?: number;
  returnDocuments?: boolean;
}

export interface RerankCandidate {
  text: string;
  metadata?: Record<string, unknown>;
  index?: number; // Original position in results
}

export interface RerankResult {
  index: number; // Original index in candidates array
  relevanceScore: number;
  text?: string;
  metadata?: Record<string, unknown>;
}

export class RerankService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly logs: Logger;
  private readonly defaultTopN: number;

  constructor(options: RerankOptions = {}) {
    if (!env.COHERE_API_KEY) {
      throw new Error('COHERE_API_KEY is not configured');
    }

    this.apiKey = env.COHERE_API_KEY;
    this.baseUrl = env.COHERE_BASE_URL || 'https://api.cohere.ai/v1';
    // Use multilingual model for Norwegian text support
    // rerank-multilingual-v3.0 supports 100+ languages including Norwegian
    this.model = options.model || 'rerank-multilingual-v3.0';
    this.logs = options.logger ?? defaultLogger;
    this.defaultTopN = options.topN ?? 10;

    this.logs.info({ model: this.model, baseUrl: this.baseUrl }, 'RerankService initialized');
  }

  /**
   * Re-rank search results using Cohere Rerank API.
   * 
   * @param query - Search query
   * @param candidates - Array of candidate documents to re-rank
   * @param topN - Number of top results to return (default: 10)
   * @returns Re-ranked results sorted by relevance score (highest first)
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topN?: number
  ): Promise<RerankResult[]> {
    if (!query || query.trim().length === 0) {
      throw new Error('Query cannot be empty');
    }

    if (!candidates || candidates.length === 0) {
      return [];
    }

    const targetTopN = topN ?? this.defaultTopN;
    
    // Cohere Rerank API has limits - typically 100 documents per request
    const maxCandidatesPerRequest = 100;
    
    if (candidates.length > maxCandidatesPerRequest) {
      this.logs.warn(
        { 
          candidateCount: candidates.length, 
          maxCandidates: maxCandidatesPerRequest 
        },
        'Too many candidates, truncating to max'
      );
      candidates = candidates.slice(0, maxCandidatesPerRequest);
    }

    // Extract text from candidates
    const documents = candidates.map((c, idx) => {
      // Use text field, or construct from metadata if needed
      let text = c.text;
      if (!text && c.metadata) {
        // Construct text from metadata fields
        const parts: string[] = [];
        if (c.metadata.title) parts.push(String(c.metadata.title));
        if (c.metadata.snippet) parts.push(String(c.metadata.snippet));
        if (c.metadata.content) parts.push(String(c.metadata.content));
        text = parts.join(' ');
      }
      return text || '';
    });

    // Filter out empty documents
    const validCandidates: Array<{ candidate: RerankCandidate; text: string; originalIndex: number }> = [];
    documents.forEach((text, idx) => {
      if (text && text.trim().length > 0) {
        validCandidates.push({
          candidate: candidates[idx],
          text,
          originalIndex: idx
        });
      }
    });

    if (validCandidates.length === 0) {
      this.logs.warn('No valid candidates for re-ranking');
      return [];
    }

    try {
      const rerankTimer = new Timer('cohere_rerank', this.logs, {
        query: query.substring(0, 100),
        candidateCount: validCandidates.length,
        targetTopN
      });
      
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          query: query,
          documents: validCandidates.map(c => c.text),
          top_n: Math.min(targetTopN, validCandidates.length),
          return_documents: false
        })
      });

      rerankTimer.end();

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Cohere Rerank API error (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const data = await response.json() as {
        results?: Array<{
          index: number;
          relevance_score: number;
        }>;
        meta?: {
          api_version?: {
            version?: string;
          };
        };
      };

      if (!data.results || !Array.isArray(data.results)) {
        throw new Error('Invalid response format from Cohere Rerank API');
      }

      // Map results back to original candidates with metadata
      const rerankedResults: RerankResult[] = data.results.map(result => {
        const validCandidate = validCandidates[result.index];
        if (!validCandidate) {
          throw new Error(`Invalid result index: ${result.index}`);
        }

        return {
          index: validCandidate.originalIndex, // Original index in candidates array
          relevanceScore: result.relevance_score,
          text: validCandidate.text,
          metadata: validCandidate.candidate.metadata
        };
      });

      this.logs.info({
        queryLength: query.length,
        candidateCount: candidates.length,
        validCandidateCount: validCandidates.length,
        rerankedCount: rerankedResults.length,
        topScore: rerankedResults[0]?.relevanceScore,
        bottomScore: rerankedResults[rerankedResults.length - 1]?.relevanceScore
      }, 'Re-ranking completed');

      return rerankedResults;
    } catch (error) {
      this.logs.error({ 
        err: error, 
        query: query.substring(0, 100),
        candidateCount: candidates.length
      }, 'Failed to re-rank results');
      throw error;
    }
  }

  /**
   * Check if re-ranking service is available.
   */
  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }
}

