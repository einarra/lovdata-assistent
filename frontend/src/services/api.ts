// In production on Vercel, use /api prefix for backend routes
// In development, use VITE_API_URL or default to localhost
const isProduction = import.meta.env.PROD;
const API_BASE_URL = isProduction 
  ? '/api' 
  : (import.meta.env.VITE_API_URL || 'http://localhost:4000');

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

  async healthCheck(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }
    return response.json();
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
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Skill run failed: ${response.statusText}`);
    }

    return response.json();
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
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Assistant run failed: ${response.statusText}`);
    }

    return response.json();
  }

  async fetchSession(token: string): Promise<SessionInfo> {
    const response = await fetch(`${this.baseUrl}/session`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      throw new Error('Kunne ikke hente sesjonsinformasjon');
    }
    return response.json();
  }
}

export const apiService = new ApiService();
