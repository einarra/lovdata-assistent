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
    // Clone response so we can read it multiple times if needed
    const clonedResponse = response.clone();
    const contentType = response.headers.get('content-type');
    
    // Check content type first
    if (!contentType || !contentType.includes('application/json')) {
      const text = await clonedResponse.text();
      const preview = text.trim().substring(0, 100);
      throw new Error(`Expected JSON but got ${contentType || 'unknown'}. Response preview: ${preview}`);
    }
    
    // Get text first to check if it's empty or malformed
    const text = await response.text();
    const trimmed = text.trim();
    
    if (!trimmed) {
      throw new Error('Received empty response body');
    }
    
    // Check if it looks like HTML
    if (trimmed.startsWith('<!') || trimmed.startsWith('<html')) {
      throw new Error(`Received HTML instead of JSON. Preview: ${trimmed.substring(0, 100)}`);
    }
    
    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      throw new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}. Response preview: ${trimmed.substring(0, 100)}`);
    }
  }
  
  // Helper to safely parse error responses (response body can only be read once)
  private async parseErrorResponse(response: Response): Promise<{ message?: string; detail?: string }> {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      try {
        return await response.json();
      } catch {
        // If JSON parsing fails, return empty object
        return {};
      }
    }
    return {};
  }

  async healthCheck(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      let errorMessage = `Health check failed: ${response.statusText}`;
      try {
        const errorData = await this.parseErrorResponse(response);
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If parsing fails, use status text
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
        const errorData = await this.parseErrorResponse(response);
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If parsing fails, use status text
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
        const errorData = await this.parseErrorResponse(response);
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If parsing fails, use status text
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
        const errorData = await this.parseErrorResponse(response);
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch {
        // If parsing fails, use default message
      }
      throw new Error(errorMessage);
    }
    return this.parseJsonResponse<SessionInfo>(response);
  }
}

export const apiService = new ApiService();
