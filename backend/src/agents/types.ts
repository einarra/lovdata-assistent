export type AgentEvidence = {
  id: string;
  source: string;
  title?: string | null;
  snippet?: string | null;
  content?: string | null;
  link?: string | null;
  date?: string | null;
  metadata?: Record<string, unknown>;
};

export type AgentInput = {
  question: string;
  evidence: AgentEvidence[];
  locale?: string;
  functions?: Array<{
    name: string;
    description?: string;
    parameters: object;
  }>;
  functionResults?: AgentFunctionResult[];
};

export type AgentOutputCitation = {
  evidenceId: string;
  label: string;
  quote?: string;
};

export type AgentFunctionCall = {
  name: string;
  arguments: string; // JSON string
  toolCallId: string; // ID from OpenAI's tool_calls (must be <= 40 chars)
};

export type AgentFunctionResult = {
  name: string;
  result: unknown;
  toolCallId: string; // ID from OpenAI's tool_calls (must be <= 40 chars)
};

export type AgentOutput = {
  answer?: string;
  citations?: AgentOutputCitation[];
  model?: string;
  functionCalls?: AgentFunctionCall[];
};

export interface Agent {
  generate(input: AgentInput): Promise<AgentOutput>;
}
