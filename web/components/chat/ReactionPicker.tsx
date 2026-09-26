'use client';

import { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { CHAT_REACTION_EMOJIS, type ChatReactionEmoji } from '@/types';
import { Portal } from '@/components/ui/Portal';

/**
 * `useLayoutEffect` roda antes da pintura, então o picker já aparece no lugar
 * certo no primeiro frame. Cai para `useEffect` no servidor, onde o primeiro
 * geraria aviso de SSR.
 */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface ReactionData {
  emoji: string;
  count: number;
  users: string[];
  hasCurrentUser: boolean;
}

interface Props {
  /** Indica se o picker de reações está visível. */
  isOpen: boolean;
  /** Callback para fechar o picker. */
  onClose: () => void;
  /** Dados das reações atuais na mensagem. */
  reactions: ReactionData[];
  /** ID da mensagem. */
  messageId: string;
  /** Callback para adicionar/remover reação. */
  onToggle: (messageId: string, emoji: string) => void;
  /** Referência ao elemento âncora (botão de reações). */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

const QUICK_REACTIONS: ChatReactionEmoji[] = ['❤️', '👍', '😂', '😮', '🔥', '🎉'];

export function ReactionPicker({
  isOpen,
  onClose,
  reactions,
  messageId,
  onToggle,
  anchorRef,
}: Props) {
  const [showFull, setShowFull] = useState(false);
  /**
   * O nó do container em `state`, e não em `useRef`, de propósito: o `Portal`
   * resolve o alvo num `useLayoutEffect` e só então monta os filhos, ou seja,
   * o div chega ao DOM um render depois de `isOpen` virar `true`. Com um ref
   * comum o efeito de posicionamento rodaria antes do elemento existir e,
   * como as dependências não mudariam, ele nunca mais rodaria — o picker
   * ficaria no canto da tela até o próximo scroll.
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  // Fecha o estado expandido caso o picker feche
  useEffect(() => {
    if (!isOpen) {
      setShowFull(false);
    }
  }, [isOpen]);

  // Fecha ao clicar fora, ignorando o próprio container e a âncora (botão acionador)
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (container?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef, container]);

  // Recálculo dinâmico da posição em relação à âncora
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || !container) return;

    const rect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Limites horizontais/verticais: o painel do chat quando ele existe.
    // Usar só a viewport faria o picker "vazar" por cima do vídeo, já que o
    // botão de reação fica encostado na borda direita do painel.
    const boundsEl = anchor.closest('[data-reaction-bounds]');
    const bounds = boundsEl?.getBoundingClientRect();
    const minX = (bounds ? bounds.left : 0) + 8;
    const maxX = (bounds ? bounds.right : window.innerWidth) - 8;

    let top = rect.top - containerRect.height - 8;
    let left = rect.left + rect.width / 2 - containerRect.width / 2;

    // Sem espaço acima, abre abaixo do botão.
    if (top < 8) {
      top = rect.bottom + 8;
    }

    // Não deixa vazar para fora dos limites.
    if (left < minX) left = minX;
    if (left + containerRect.width > maxX) left = maxX - containerRect.width;
    // Se ainda assim não couber (painel mais estreito que o picker), encosta
    // na borda esquerda em vez de centralizar e empurrar para fora da tela.
    if (left < minX) left = minX;

    container.style.top = `${top}px`;
    container.style.left = `${left}px`;
  }, [anchorRef, container]);

  // Atualiza posição no scroll, resize e quando abre/expande
  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, showFull, updatePosition]);

  if (!isOpen) return null;

  const allEmojis = [...new Set([...QUICK_REACTIONS, ...reactions.map((r) => r.emoji)])];

  return (
    <Portal>
      <div
        ref={setContainer}
        className="fixed z-50 transition-opacity duration-150 opacity-100"
        role="menu"
        aria-label="Reações"
      >
        <div className="flex items-center gap-1 rounded-xl bg-surface border border-hairline shadow-lg px-2 py-1.5">
          {allEmojis.map((emoji) => {
            const reaction = reactions.find((r) => r.emoji === emoji);
            const count = reaction?.count ?? 0;
            const hasCurrentUser = reaction?.hasCurrentUser ?? false;

            return (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                onClick={() => {
                  onToggle(messageId, emoji);
                  onClose();
                }}
                className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 transition-all duration-150 ${
                  hasCurrentUser
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-hover hover:text-ink'
                }`}
                aria-label={`${emoji} ${count > 0 ? `${count} reações` : 'sem reações'}`}
                aria-pressed={hasCurrentUser}
              >
                <span className="text-lg">{emoji}</span>
                {count > 0 && (
                  <span
                    className={`text-[0.625rem] font-medium ${
                      hasCurrentUser ? 'text-accent' : 'text-ink-faint'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            role="menuitem"
            onClick={() => setShowFull((prev) => !prev)}
            className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-ink-muted hover:bg-hover hover:text-ink transition-colors"
            aria-label="Mais reações"
          >
            <span className="text-lg">⋯</span>
            <span className="text-[0.625rem]">mais</span>
          </button>
        </div>

        {/* Menu Expandido */}
        {showFull && (
          <div
            className="absolute left-0 top-full mt-2 w-72 rounded-xl border border-hairline bg-surface shadow-lg overflow-hidden animate-fade-up z-50 p-2"
            role="dialog"
            aria-label="Todas as reações"
          >
            <p className="text-xs font-medium text-ink-muted mb-2">Escolha uma reação</p>
            <div className="grid grid-cols-6 gap-1 max-h-60 overflow-y-auto">
              {CHAT_REACTION_EMOJIS.map((emoji) => {
                const reaction = reactions.find((r) => r.emoji === emoji);
                const count = reaction?.count ?? 0;
                const hasCurrentUser = reaction?.hasCurrentUser ?? false;

                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onToggle(messageId, emoji);
                      onClose();
                    }}
                    className={`flex flex-col items-center gap-0.5 rounded-lg p-1.5 transition-colors ${
                      hasCurrentUser
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <span className="text-xl">{emoji}</span>
                    {count > 0 && (
                      <span className="text-[0.625rem] font-medium">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Portal>
  );
}