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

    // Add timeout to prevent hanging (5 seconds max - keep it short to leave buffer for other operations)
    // Vercel Pro has 60s limit, but we want to keep Serper calls fast
    const timeoutMs = 5000;
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
      
      // Add progress checks while waiting for fetch - set up BEFORE fetch to ensure they run
      let progressCheckInterval: NodeJS.Timeout | null = null;
      const progressCheckTimeouts: NodeJS.Timeout[] = [];
      
      // Start progress checks immediately
      console.log(`[SerperClient] Setting up progress checks...`);
      progressCheckInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[SerperClient] Still waiting for response... elapsed: ${elapsed}ms, timeout at: ${timeoutMs}ms`);
      }, 1000); // Check every 1 second for faster feedback
      
      // Also add immediate checks at 1, 2, 3 seconds - store references to clear them later
      progressCheckTimeouts.push(setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[SerperClient] 1 second check - elapsed: ${elapsed}ms`);
      }, 1000));
      
      progressCheckTimeouts.push(setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[SerperClient] 2 second check - elapsed: ${elapsed}ms`);
      }, 2000));
      
      progressCheckTimeouts.push(setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[SerperClient] 3 second check - elapsed: ${elapsed}ms`);
      }, 3000));
      
      console.log(`[SerperClient] Progress checks set up, calling fetch...`);
      
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
        if (progressCheckInterval) {
          clearInterval(progressCheckInterval);
          progressCheckInterval = null;
        }
        // Clear all progress check timeouts
        progressCheckTimeouts.forEach(timeout => clearTimeout(timeout));
        progressCheckTimeouts.length = 0;
        console.log(`[SerperClient] Progress checks cleared`);
      });
      
      console.log(`[SerperClient] Fetch promise created, awaiting response...`);
      const response = await fetchPromise;
      
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
      // Note: Progress checks are already cleared in the finally block of fetchPromise
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
