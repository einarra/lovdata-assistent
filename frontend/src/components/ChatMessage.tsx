import type { AssistantRunResponse } from '../services/api';
import type { Message } from '../types/chat';
import './ChatMessage.css';

interface ChatMessageProps {
  message: Message;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isUser = message.role === 'user';
  const assistantData = !isUser ? (isAssistantResponse(message.data) ? message.data : undefined) : undefined;

  const renderAssistantExtras = () => {
    if (!assistantData) {
      return null;
    }

    const citationMap = new Map(assistantData.citations.map((citation) => [citation.evidenceId, citation]));

    return (
      <div className="assistant-output">
        <div className="assistant-summary">
          Viser side {assistantData.pagination.page} av {assistantData.pagination.totalPages} ·{' '}
          {assistantData.evidence.length} treff
        </div>
        <ol className="assistant-evidence-list">
          {assistantData.evidence.map((item, index) => {
            const citation = citationMap.get(item.id);
            // Calculate offset based on pagination
            const offset = (assistantData.pagination.page - 1) * assistantData.pagination.pageSize;
            const label = citation?.label ?? `[${offset + index + 1}]`;
            return (
              <li key={item.id} className="assistant-evidence-item">
                <div className="assistant-evidence-header">
                  <span className="assistant-evidence-label">{label}</span>
                  <span className="assistant-evidence-title">{item.title ?? 'Uten tittel'}</span>
                  <span className="assistant-evidence-source">{item.source}</span>
                  {item.date && <span className="assistant-evidence-date">{item.date}</span>}
                </div>
                {citation?.quote && <div className="assistant-evidence-quote">«{citation.quote}»</div>}
                {item.snippet && <div className="assistant-evidence-snippet">{item.snippet}</div>}
                {item.link && (
                  <a className="assistant-evidence-link" href={item.link} target="_blank" rel="noreferrer">
                    Åpne kilde
                  </a>
                )}
              </li>
            );
          })}
        </ol>
        {assistantData.metadata.fallbackProvider && (
          <div className="assistant-fallback">
            Tilleggsinformasjon fra {assistantData.metadata.fallbackProvider}.
          </div>
        )}
      </div>
    );
  };
  
  return (
    <div className={`chat-message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
        {isUser ? 'U' : 'A'}
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-role">{isUser ? 'Deg' : 'Assistent'}</span>
          <span className="message-time">
            {message.timestamp.toLocaleTimeString()}
          </span>
        </div>
        <div className="message-text">{message.content}</div>
        {!isUser && renderAssistantExtras()}
      </div>
    </div>
  );
};

function isAssistantResponse(value: unknown): value is AssistantRunResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'evidence' in value &&
      'pagination' in value &&
      Array.isArray((value as AssistantRunResponse).evidence)
  );
}

