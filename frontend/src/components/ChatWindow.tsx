import { useEffect, useRef, type ReactNode } from 'react';
import type { Message } from '../types/chat';
import { ChatMessage } from './ChatMessage';
import './ChatWindow.css';

interface ChatWindowProps {
  messages: Message[];
  isLoading?: boolean;
  inputSlot?: ReactNode;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({ messages, isLoading, inputSlot }) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  return (
    <div ref={containerRef} className="chat-window">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>ParagrafSvar</h2>
            <p>
               ParagrafSvar er en chatbot som kan gi svar på spørsmål om norske juridiske data fra Lovdata.no.
              
            </p>
            <ul className="empty-state-list">
              ParagrafSvar kan:
              <li>Søke gjennom juridiske dokumenter</li>
              <li>Trekke ut og analysere juridisk innhold</li>
              <li>Gi svar på spørsmål fra brukeren</li>
            </ul>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
            {isLoading && (
              <div className="loading-indicator">
                <div className="loading-avatar"></div>
                <div className="loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>
      {inputSlot && <div className="chat-input-slot">{inputSlot}</div>}
    </div>
  );
};

