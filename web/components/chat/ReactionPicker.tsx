'use client';

import { useEffect, useRef, useState } from 'react';
import { CHAT_REACTION_EMOJIS, type ChatReactionEmoji } from '@/types';
import { Portal } from '@/components/ui/Portal';

interface ReactionData {
  emoji: string;
  count: number;
  users: string[];
  hasCurrentUser: boolean;
}

interface Props {
  /** Dados das reações atuais na mensagem. */
  reactions: ReactionData[];
  /** ID da mensagem. */
  messageId: string;
  /** ID do usuário atual (sessionId). */
  currentUserId: string;
  /** Callback para adicionar/remover reação. */
  onToggle: (messageId: string, emoji: string) => void;
  /** Referência ao elemento âncora (botão de reações). */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  /** Se o usuário está no mobile. */
  isMobile?: boolean;
}

const QUICK_REACTIONS: ChatReactionEmoji[] = ['❤️', '👍', '😂', '😮', '🔥', '🎉'];

export function ReactionPicker({
  reactions,
  messageId,
  currentUserId,
  onToggle,
  anchorRef,
  isMobile = false,
}: Props) {
  const [showFull, setShowFull] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowFull(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Posicionamento
  useEffect(() => {
    const anchor = anchorRef.current;
    const container = containerRef.current;
    if (!anchor || !container) return;

    const rect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Posiciona acima da mensagem
    container.style.top = `${rect.top + window.scrollY - containerRect.height - 8}px`;
    container.style.left = `${rect.left + window.scrollX - containerRect.width / 2 + rect.width / 2}px`;

    // Ajusta se passar da tela
    if (containerRect.left < 8) {
      container.style.left = '8px';
    }
    if (containerRect.right > window.innerWidth - 8) {
      container.style.left = `${window.innerWidth - containerRect.width - 8}px`;
    }
  }, [anchorRef, showFull]);

  // Reações rápidas (sempre visíveis) + botão "mais" se houver mais reações
  const allEmojis = [...new Set([...QUICK_REACTIONS, ...reactions.map(r => r.emoji)])];

  return (
    <Portal>
      <div
        ref={containerRef}
        className={`fixed z-50 transition-all duration-150 ${showFull ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        role="menu"
        aria-label="Reações"
      >
        <div className="flex items-center gap-1 rounded-xl bg-surface border border-hairline shadow-lg px-2 py-1.5">
          {allEmojis.map((emoji) => {
            const reaction = reactions.find(r => r.emoji === emoji);
            const count = reaction?.count ?? 0;
            const hasCurrentUser = reaction?.hasCurrentUser ?? false;

            return (
              <button
                key={emoji}
                role="menuitem"
                onClick={() => {
                  onToggle(messageId, emoji);
                  if (!isMobile) setShowFull(false);
                }}
                className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 transition-all duration-150 ${
                  hasCurrentUser
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-hover hover:text-ink'
                }`}
                aria-label={`${emoji} ${count > 0 ? `${count} reação${count > 1 ? 'ões' : ''}` : 'sem reações'}`}
                aria-pressed={hasCurrentUser}
              >
                <span className="text-lg">{emoji}</span>
                {count > 0 && (
                  <span className={`text-[0.625rem] font-medium ${hasCurrentUser ? 'text-accent' : 'text-ink-faint'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}

          {/* Botão "mais" se houver reações além das rápidas */}
          {reactions.some(r => !QUICK_REACTIONS.includes(r.emoji as ChatReactionEmoji)) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => setShowFull(true)}
              className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-ink-muted hover:bg-hover hover:text-ink transition-colors"
              aria-label="Mais reações"
            >
              <span className="text-lg">⋯</span>
              <span className="text-[0.625rem]">mais</span>
            </button>
          )}
        </div>

        {/* Picker completo (aparece ao clicar em "mais") */}
        {showFull && (
          <div
            className="fixed z-50 w-72 rounded-xl border border-hairline bg-surface shadow-lg overflow-hidden animate-fade-up mt-2"
            role="dialog"
            aria-label="Todas as reações"
          >
            <div className="p-2 border-b border-hairline">
              <p className="text-xs font-medium text-ink-muted mb-2">Escolha uma reação</p>
              <div className="grid grid-cols-8 gap-1 max-h-60 overflow-y-auto">
                {CHAT_REACTION_EMOJIS.map((emoji) => {
                  const reaction = reactions.find(r => r.emoji === emoji);
                  const count = reaction?.count ?? 0;
                  const hasCurrentUser = reaction?.hasCurrentUser ?? false;

                  return (
                    <button
                      key={emoji}
                      role="option"
                      onClick={() => {
                        onToggle(messageId, emoji);
                        setShowFull(false);
                      }}
                      className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 transition-colors ${
                        hasCurrentUser
                          ? 'bg-accent-soft text-accent'
                          : 'text-ink-muted hover:bg-hover hover:text-ink'
                      }`}
                      aria-label={`${emoji} ${count > 0 ? `${count} reação${count > 1 ? 'ões' : ''}` : 'sem reações'}`}
                      aria-pressed={hasCurrentUser}
                    >
                      <span className="text-xl">{emoji}</span>
                      {count > 0 && (
                        <span className={`text-[0.625rem] font-medium ${hasCurrentUser ? 'text-accent' : 'text-ink-faint'}`}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </Portal>
  );
}