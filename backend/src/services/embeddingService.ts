/**
 * Embedding service for generating vector embeddings using OpenAI.
 * 
 * This service generates embeddings for documents to enable semantic search
 * using OpenAI's text-embedding-3-small model (1536 dimensions).
 */

import OpenAI from 'openai';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger.js';
import { env } from '../config/env.js';

export interface EmbeddingOptions {
  logger?: Logger;
  model?: string;
  batchSize?: number;
}

export class EmbeddingService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logs: Logger;
  private readonly batchSize: number;

  constructor(options: EmbeddingOptions = {}) {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: 30000, // 30 second timeout
    });

    // Use text-embedding-3-small by default (1536 dimensions, cost-effective)
    this.model = options.model ?? 'text-embedding-3-small';
    this.logs = options.logger ?? defaultLogger;
    this.batchSize = options.batchSize ?? 100; // OpenAI allows up to 2048 inputs per request

    this.logs.info({ model: this.model, batchSize: this.batchSize }, 'EmbeddingService initialized');
  }

  /**
   * Generate embedding for a single text.
   * @param text - Text to generate embedding for
   * @returns Embedding vector (1536 dimensions for text-embedding-3-small)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    // Truncate text to max token limit (8191 tokens for text-embedding-3-small)
    // Very conservative estimate: 1 token ≈ 3-4 characters for Norwegian text
    // Using 20,000 chars to be safe (≈5,000-6,666 tokens, well under 8,191 limit)
    const maxLength = 20000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) : text;

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: truncatedText,
      });

      if (!response.data || response.data.length === 0) {
        throw new Error('No embedding data returned from OpenAI');
      }

      return response.data[0].embedding;
    } catch (error) {
      this.logs.error({ err: error, textLength: text.length }, 'Failed to generate embedding');
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batches.
   * @param texts - Array of texts to generate embeddings for
   * @returns Array of embedding vectors in the same order as input texts
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];
    
    // Process in batches
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      try {
        // Truncate each text in the batch
        // Very conservative limit: 20,000 chars (≈5,000-6,666 tokens, well under 8,191 limit)
        const maxLength = 20000;
        const truncatedBatch = batch.map(text => {
          if (text.length > maxLength) {
            // Truncate and add ellipsis to indicate truncation
            return text.substring(0, maxLength - 3) + '...';
          }
          return text;
        });

        const response = await this.client.embeddings.create({
          model: this.model,
          input: truncatedBatch,
        });

        if (!response.data || response.data.length !== batch.length) {
          throw new Error(`Expected ${batch.length} embeddings, got ${response.data?.length ?? 0}`);
        }

        // Extract embeddings in order
        const batchEmbeddings = response.data.map(item => item.embedding);
        results.push(...batchEmbeddings);

        this.logs.debug({ 
          batchIndex: Math.floor(i / this.batchSize) + 1,
          batchSize: batch.length,
          totalProcessed: Math.min(i + batch.length, texts.length)
        }, 'Generated embeddings batch');
      } catch (error) {
        this.logs.error({ 
          err: error, 
          batchIndex: Math.floor(i / this.batchSize) + 1,
          batchSize: batch.length
        }, 'Failed to generate embeddings batch');
        throw error;
      }
    }

    return results;
  }

  /**
   * Get the embedding dimension for the configured model.
   * @returns Dimension count (1536 for text-embedding-3-small)
   */
  getEmbeddingDimension(): number {
    // text-embedding-3-small has 1536 dimensions
    // text-embedding-3-large has 3072 dimensions
    return this.model === 'text-embedding-3-large' ? 3072 : 1536;
  }
}

