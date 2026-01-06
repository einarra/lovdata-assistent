import type { AssistantRunResponse } from '../services/api';
import type { Message } from '../types/chat';
import './ChatMessage.css';

// Helper function to render message content with clickable links
function renderMessageContent(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let keyCounter = 0;
  
  // First, handle HTML links (<a> tags)
  const htmlLinkRegex = /<a\s+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  const htmlLinks: Array<{ index: number; length: number; href: string; text: string }> = [];
  let htmlMatch;
  
  while ((htmlMatch = htmlLinkRegex.exec(content)) !== null) {
    htmlLinks.push({
      index: htmlMatch.index,
      length: htmlMatch[0].length,
      href: htmlMatch[1],
      text: htmlMatch[2]
    });
  }
  
  // Then, find plain URLs (https:// or http://) that are not inside HTML tags
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  const plainUrls: Array<{ index: number; length: number; url: string }> = [];
  let urlMatch;
  
  while ((urlMatch = urlRegex.exec(content)) !== null) {
    // Check if this URL is inside an HTML link tag
    const isInsideHtmlLink = htmlLinks.some(htmlLink => 
      urlMatch.index >= htmlLink.index && 
      urlMatch.index < htmlLink.index + htmlLink.length
    );
    
    if (!isInsideHtmlLink) {
      plainUrls.push({
        index: urlMatch.index,
        length: urlMatch[0].length,
        url: urlMatch[0]
      });
    }
  }
  
  // Combine and sort all matches by index
  const allMatches = [
    ...htmlLinks.map(link => ({ ...link, type: 'html' as const })),
    ...plainUrls.map(url => ({ ...url, type: 'plain' as const }))
  ].sort((a, b) => a.index - b.index);
  
  // Process all matches
  for (const match of allMatches) {
    // Add text before the match
    if (match.index > lastIndex) {
      const textBefore = content.substring(lastIndex, match.index);
      if (textBefore) {
        parts.push(textBefore);
      }
    }
    
    // Add the link
    if (match.type === 'html') {
      parts.push(
        <a 
          key={`link-${keyCounter++}`}
          href={match.href} 
          target="_blank" 
          rel="noreferrer noopener"
          className="message-link"
        >
          {match.text}
        </a>
      );
    } else {
      parts.push(
        <a 
          key={`link-${keyCounter++}`}
          href={match.url} 
          target="_blank" 
          rel="noreferrer noopener"
          className="message-link"
        >
          {match.url}
        </a>
      );
    }
    
    lastIndex = match.index + match.length;
  }
  
  // Add remaining text after the last match
  if (lastIndex < content.length) {
    const remainingText = content.substring(lastIndex);
    if (remainingText) {
      parts.push(remainingText);
    }
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

