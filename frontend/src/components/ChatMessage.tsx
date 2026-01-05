import type { AssistantRunResponse } from '../services/api';
import type { Message } from '../types/chat';
import './ChatMessage.css';

// Helper function to render message content with clickable links
function renderMessageContent(content: string): React.ReactNode {
  // Check if content contains HTML links
  const linkRegex = /<a\s+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  
  while ((match = linkRegex.exec(content)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      parts.push(content.substring(lastIndex, match.index));
    }
    
    // Add the link as a clickable element
    const href = match[1];
    const linkText = match[2];
    parts.push(
      <a 
        key={match.index} 
        href={href} 
        target="_blank" 
        rel="noreferrer noopener"
        className="message-link"
      >
        {linkText}
      </a>
    );
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text after the last link
  if (lastIndex < content.length) {
    parts.push(content.substring(lastIndex));
  }
  
  // If no links were found, return content as-is
  if (parts.length === 0) {
    return content;
  }
  
  return <>{parts}</>;
}

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
        <div className="message-text">
          {renderMessageContent(message.content)}
        </div>
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

