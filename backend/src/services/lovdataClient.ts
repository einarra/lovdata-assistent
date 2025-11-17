import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export type LovdataListResponse = {
  files: string[];
};

export type LovdataRequestOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
};

export class LovdataClient {
  constructor(
    private readonly baseUrl: string = env.LOVDATA_BASE_URL,
    private readonly timeoutMs: number = env.LOVDATA_TIMEOUT_MS
  ) {}

  private buildUrl(pathname: string, params?: Record<string, string | number | boolean | undefined>): URL {
    const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const url = new URL(normalizedPath, this.baseUrl);
    if (params) {
      Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .forEach(([key, value]) => url.searchParams.set(key, String(value)));
    }
    return url;
  }

  private async request<T>(pathname: string, options: LovdataRequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = this.buildUrl(pathname, options.params);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: options.signal ?? controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Lovdata request failed (${response.status}): ${body}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const buffer = await response.arrayBuffer();
        return { buffer, contentType } as unknown as T;
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getBinary(pathname: string, options: LovdataRequestOptions = {}): Promise<{ buffer: Buffer; contentType: string }> {
    const { stream, contentType } = await this.getBinaryStream(pathname, options);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  }

  async listPublicData(): Promise<LovdataListResponse> {
    const data = await this.request<unknown>('/v1/public/list');
    if (Array.isArray(data)) {
      const files = data
        .map(item => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'filename' in item && typeof (item as any).filename === 'string') {
            return (item as any).filename as string;
          }
          return undefined;
        })
        .filter((value): value is string => Boolean(value));
      return { files };
    }
    if (data && typeof data === 'object' && 'files' in data && Array.isArray((data as any).files)) {
      const files = (data as any).files
        .map((item: unknown) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'filename' in item && typeof (item as any).filename === 'string') {
            return (item as any).filename as string;
          }
          return undefined;
        })
        .filter((value: string | undefined): value is string => Boolean(value));
      return { files };
    }
    throw new Error('Unexpected response from Lovdata public/list');
  }

  async getJson<T = unknown>(pathname: string, options: LovdataRequestOptions = {}): Promise<T> {
    return this.request<T>(pathname, options);
  }

  async extractXml(filename: string, member: string): Promise<{ text: string; title?: string | null; date?: string | null }> {
    if (!filename) {
      throw new Error('filename is required for extractXml');
    }
    if (!member) {
      throw new Error('member is required for extractXml');
    }

    const encodedFilename = encodeURIComponent(filename);
    const normalisedMember = member.replace(/\\/g, '/');
    const encodedMember = normalisedMember
      .split('/')
      .map(part => encodeURIComponent(part))
      .join('/');

    const path = `/v1/public/extract/${encodedFilename}/${encodedMember}`;
    logger.debug({ path, baseUrl: this.baseUrl }, 'Requesting Lovdata extract');
    let response: { text?: string; title?: string | null; date?: string | null };
    try {
      response = await this.getJson<{ text?: string; title?: string | null; date?: string | null }>(path);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Lovdata extract failed for ${filename}:${member} (${path} @ ${this.baseUrl}) - ${errMessage}`);
    }

    if (!response || typeof response !== 'object' || typeof response.text !== 'string') {
      throw new Error('Lovdata extract response did not include text content');
    }

    return {
      text: response.text,
      title: response.title ?? null,
      date: response.date ?? null
    };
  }

  async getBinaryStream(
    pathname: string,
    options: LovdataRequestOptions = {}
  ): Promise<{ stream: Readable; contentType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = this.buildUrl(pathname, options.params);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: options.signal ?? controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Lovdata request failed (${response.status}): ${body}`);
      }

      if (!response.body) {
        throw new Error('Lovdata response stream was empty');
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const nodeStream = Readable.fromWeb(response.body as any) as Readable;
      return { stream: nodeStream, contentType };
    } finally {
      clearTimeout(timeout);
    }
  }
}
