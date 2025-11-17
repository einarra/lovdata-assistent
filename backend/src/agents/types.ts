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
};

export type AgentOutputCitation = {
  evidenceId: string;
  label: string;
  quote?: string;
};

export type AgentOutput = {
  answer: string;
  citations: AgentOutputCitation[];
  model?: string;
};

export interface Agent {
  generate(input: AgentInput): Promise<AgentOutput>;
}
