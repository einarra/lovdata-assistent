import { env } from '../config/env.js';

export type SerperSearchOptions = {
  num?: number;
  gl?: string;
  hl?: string;
  site?: string;
};

export type SerperResponse = {
  searchParameters?: Record<string, unknown>;
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    date?: string;
  }>;
  [key: string]: unknown;
};

export class SerperClient {
  constructor(
    private readonly apiKey: string | undefined = env.SERPER_API_KEY,
    private readonly baseUrl: string = env.SERPER_BASE_URL
  ) {}

  private assertConfigured() {
    if (!this.apiKey) {
      throw new Error('SERPER_API_KEY is required to use the browsing skill.');
    }
  }

  async search(query: string, options: SerperSearchOptions = {}): Promise<SerperResponse> {
    this.assertConfigured();
    const payload = {
      q: options.site ? `site:${options.site} ${query}` : query,
      num: options.num ?? 10,
      gl: options.gl ?? 'no',
      hl: options.hl ?? 'no'
    };

    // Add timeout to prevent hanging (30 seconds max)
    const timeoutMs = 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey!
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Serper search failed (${response.status}): ${body}`);
      }

      return (await response.json()) as SerperResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Serper search timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }
}
