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
    
    // Normalize site to remove protocol if present (Serper expects just the domain)
    let siteQuery = '';
    if (options.site) {
      const normalizedSite = options.site.replace(/^https?:\/\//, '').replace(/\/$/, '');
      siteQuery = `site:${normalizedSite} `;
    }
    
    const payload = {
      q: `${siteQuery}${query}`.trim(),
      num: options.num ?? 10,
      gl: options.gl ?? 'no',
      hl: options.hl ?? 'no'
    };

    // Add timeout to prevent hanging (8 seconds max - keep it short since we've already used ~4s on DB query)
    const timeoutMs = 8000;
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[SerperClient] Timeout triggered after ${elapsed}ms`);
      controller.abort();
    }, timeoutMs);

    try {
      console.log(`[SerperClient] Starting search: ${query.substring(0, 50)}...`);
      console.log(`[SerperClient] URL: ${this.baseUrl}, timeout: ${timeoutMs}ms`);
      console.log(`[SerperClient] About to call fetch with AbortController signal`);
      
      // Add progress checks while waiting for fetch
      const progressCheckInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[SerperClient] Still waiting for response... elapsed: ${elapsed}ms, timeout at: ${timeoutMs}ms`);
      }, 2000); // Check every 2 seconds
      
      const fetchPromise = fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey!
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).finally(() => {
        // Clear progress checks when fetch completes (success or error)
        clearInterval(progressCheckInterval);
      });
      
      console.log(`[SerperClient] Fetch promise created, awaiting response...`);
      
      // Wrap in Promise.race to ensure timeout always triggers
      const responsePromise = fetchPromise;
      const timeoutWrapper = new Promise<Response>((_, reject) => {
        // The timeout is already handled by AbortController, but this ensures we catch it
        setTimeout(() => {
          const elapsed = Date.now() - startTime;
          if (elapsed >= timeoutMs - 100) { // Give a 100ms buffer
            console.log(`[SerperClient] Timeout wrapper triggered after ${elapsed}ms`);
            reject(new Error(`Fetch timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs + 100);
      });
      
      const response = await Promise.race([responsePromise, timeoutWrapper]);
      
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      console.log(`[SerperClient] Response received after ${elapsed}ms, status: ${response.status}`);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Serper search failed (${response.status}): ${body}`);
      }

      console.log(`[SerperClient] Parsing response JSON...`);
      const jsonResult = await response.json() as SerperResponse;
      const totalElapsed = Date.now() - startTime;
      console.log(`[SerperClient] Search completed successfully after ${totalElapsed}ms`);
      return jsonResult;
    } catch (error) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      console.log(`[SerperClient] Catch block entered after ${elapsed}ms`);
      console.log(`[SerperClient] Error after ${elapsed}ms:`, error instanceof Error ? error.message : String(error));
      console.log(`[SerperClient] Error type: ${error instanceof Error ? error.name : typeof error}`);
      if (error instanceof Error && error.stack) {
        console.log(`[SerperClient] Error stack: ${error.stack.substring(0, 500)}`);
      }
      
      if (error instanceof Error && error.name === 'AbortError') {
        console.log(`[SerperClient] AbortError detected, throwing timeout error`);
        throw new Error(`Serper search timed out after ${timeoutMs}ms`);
      }
      console.log(`[SerperClient] Re-throwing error`);
      throw error;
    }
  }
}
