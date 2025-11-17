import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { OpenAIAgent, type OpenAIAgentOptions } from './openAIAgent.js';
import type { Agent } from './types.js';

let agentInstance: Agent | null | undefined;

export function getAgent(options: OpenAIAgentOptions = {}): Agent | null {
  if (agentInstance !== undefined) {
    return agentInstance;
  }

  if (!env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY missing; assistant responses will fall back to rule-based summaries.');
    agentInstance = null;
    return agentInstance;
  }

  try {
    agentInstance = new OpenAIAgent(options);
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialise OpenAI agent');
    agentInstance = null;
  }
  return agentInstance;
}
