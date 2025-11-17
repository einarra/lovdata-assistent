/**
 * Type definitions for chat functionality.
 */

import type { AssistantRunResponse, SkillRunResponse } from '../services/api';

export type MessageData = SkillRunResponse | AssistantRunResponse;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  data?: MessageData;
}

