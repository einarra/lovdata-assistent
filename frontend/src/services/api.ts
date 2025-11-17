// In production on Vercel, use /api prefix for backend routes
// In development, use VITE_API_URL or default to localhost
const isProduction = import.meta.env.PROD;
// Explicitly check for VITE_API_URL first, then use /api in production, localhost in dev
const API_BASE_URL = import.meta.env.VITE_API_URL 
  ? import.meta.env.VITE_API_URL
  : (isProduction ? '/api' : 'http://localhost:4000');

export interface SkillRunRequest {
  input: unknown;
  hints?: Record<string, unknown>;
  context?: {
    userId?: string;
    locale?: string;
  };
}

export interface SkillRunResponse {
  result: unknown;
  meta?: {
    skill?: string;
    action?: string;
    [key: string]: unknown;
  };
  artifacts?: Record<string, string>;
}

export interface HealthResponse {
  status: string;
  uptime: number;
}

export interface AssistantRunRequest {
  question: string;
  page?: number;
  pageSize?: number;
  locale?: string;
}

export interface AssistantEvidence {
  id: string;
  source: string;
  title?: string | null;
  snippet?: string | null;
  link?: string | null;
  date?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AssistantRunResponse {
  answer: string;
  evidence: AssistantEvidence[];
  citations: Array<{ evidenceId: string; label: string; quote?: string }>;
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
    generatedAt: string;
    processingTimeMs: number;
  };
}

export interface SessionInfo {
  user: {
    id: string;
    email: string | null;
    role?: string;
  } | null;
  subscription: {
    customerId: string | null;
    subscriptionId: string | null;
    status: string;
    priceId: string;
    currentPeriodEnd: string | null;
  } | null;
}

class ApiService {
  private readonly baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  // Helper to safely parse JSON responses
  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
    }
    try {
      return await response.json();
    } catch (error) {
      const text = await response.text();
      throw new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}. Response: ${text.substring(0, 100)}`);
    }
  }

  async healthCheck(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      let errorMessage = `Health check failed: ${response.statusText}`;
      try {
        const errorData = await this.parseJsonResponse(response);
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If response is not JSON, try to get text
        const text = await response.text().catch(() => '');
        if (text && !text.startsWith('<!')) {
          errorMessage = text;
        }
      }
      throw new Error(errorMessage);
    }
    return this.parseJsonResponse<HealthResponse>(response);
  }

  async runSkill(payload: SkillRunRequest): Promise<SkillRunResponse> {
    const response = await fetch(`${this.baseUrl}/skills/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorMessage = `Skill run failed: ${response.statusText}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If response is not JSON, use status text
        const text = await response.text().catch(() => '');
        if (text && !text.startsWith('<!')) {
          errorMessage = text;
        }
      }
      throw new Error(errorMessage);
    }

    return this.parseJsonResponse<SkillRunResponse>(response);
  }

  async assistantRun(payload: AssistantRunRequest, token?: string): Promise<AssistantRunResponse> {
    const response = await fetch(`${this.baseUrl}/assistant/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorMessage = `Assistant run failed: ${response.statusText}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If response is not JSON, use status text
        const text = await response.text().catch(() => '');
        if (text && !text.startsWith('<!')) {
          errorMessage = text;
        }
      }
      throw new Error(errorMessage);
    }

    return this.parseJsonResponse<AssistantRunResponse>(response);
  }

  async fetchSession(token: string): Promise<SessionInfo> {
    const response = await fetch(`${this.baseUrl}/session`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      let errorMessage = 'Kunne ikke hente sesjonsinformasjon';
      try {
        const errorData = await this.parseJsonResponse(response);
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If response is not JSON, use status text
        const text = await response.text().catch(() => '');
        if (text && !text.startsWith('<!')) {
          errorMessage = text;
        }
      }
      throw new Error(errorMessage);
    }
    return this.parseJsonResponse<SessionInfo>(response);
  }
}

export const apiService = new ApiService();
