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
   * Se a barra rápida ancorou **para cima** do botão de reação.
   *
   * É estado, e não algo derivado do CSS, porque o menu expandido precisa saber
   * para que lado crescer — e a âncora (`top`, em px, escrito por
   * `updatePosition`) só existe depois do primeiro layout. Ler a posição aqui
   * seria medir o DOM no render, que é o que a medição em `useLayoutEffect`
   * existe para evitar.
   */
  const [acimaDoBotao, setAcimaDoBotao] = useState(true);
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

  /**
   * O nó do menu expandido, medido para o cálculo de espaço.
   *
   * Está em `state` pelo mesmo motivo do `container`: o `Portal` monta os filhos
   * um render depois de `isOpen`, e um ref comum mediria zero.
   */
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);

  /**
   * Reposiciona o picker, medindo o que ele **realmente** ocupa.
   *
   * ## A medição anterior media metade do que era preciso
   *
   * O menu expandido é `absolute top-full`, ou seja, sai da caixa do container
   * para baixo. O `containerRect.height` media só a barra rápida — o menu não
   * contava. O cálculo dizia "cabe acima" com folga de 40px, posicionava, e o
   * menu de 200px aparecia em cima da barra de escrever e do fim da viewport. Era
   * o sintoma reportado: abre muito para baixo e fica cortado.
   *
   * Aqui a altura somada é a barra mais o menu mais a folga, e o `top` é
   * calculado com o total. A barra também muda de lado, o que importa porque
   * `bottom-full` e `top-full` são propriedades diferentes e precisam combinar
   * com o `top` que o JS escreve.
   */
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || !container) return;

    const rect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const alturaMenu = menu?.offsetHeight ?? 0;
    const FOLGA = 8;
    // `top-full mt-2` no menu vale 8px de distância entre a barra e ele.
    const alturaTotal = containerRect.height + (alturaMenu > 0 ? alturaMenu + FOLGA : 0);

    // Limites horizontais/verticais: o painel do chat quando ele existe.
    // Usar só a viewport faria o picker "vazar" por cima do vídeo, já que o
    // botão de reação fica encostado na borda direita do painel.
    const boundsEl = anchor.closest('[data-reaction-bounds]');
    const bounds = boundsEl?.getBoundingClientRect();
    const minX = (bounds ? bounds.left : 0) + 8;
    const maxX = (bounds ? bounds.right : window.innerWidth) - 8;

    let left = rect.left + rect.width / 2 - containerRect.width / 2;

    // Não deixa vazar para fora dos limites.
    if (left < minX) left = minX;
    if (left + containerRect.width > maxX) left = maxX - containerRect.width;
    // Se ainda assim não couber (painel mais estreito que o picker), encosta
    // na borda esquerda em vez de centralizar e empurrar para fora da tela.
    if (left < minX) left = minX;

    const MARGEM = 8;
    const espacoAcima = rect.top - MARGEM;
    const espacoAbaixo = window.innerHeight - rect.bottom - MARGEM;

    /*
     * A barra é quem ancora no botão, e o menu cresce **para longe** dela.
     *
     * A ordem aqui é: primeiro quem tem espaço para o **conjunto**, e só depois
     * o lado. Abrir a barra para cima porque há espaço e o menu para baixo — que
     * é o que a versão anterior fazia — põe o menu exatamente onde não há espaço.
     */
    const cabeAcima = espacoAcima >= alturaTotal;
    const cabeAbaixo = espacoAbaixo >= alturaTotal;
    /*
     * Este `set` roda a cada `scroll` e a cada `resize`, e parece desperdício de
     * render. Não é: o React descarta a atualização quando o estado é o mesmo, e
     * `acimaDoBotao` só muda quando o picker **troca de lado** — o que numa
     * rolagem de chat é raro. O guarda `!==` abaixo deixa isso explícito e evita
     * o custo de um render por quadro durante o arraste da barra de rolagem.
     */
    const lado = cabeAcima || (!cabeAbaixo && espacoAcima >= espacoAbaixo);
    if (lado !== acimaDoBotao) setAcimaDoBotao(lado);

    let top: number;
    if (cabeAcima) {
      top = rect.top - alturaTotal;
    } else if (cabeAbaixo) {
      top = rect.bottom;
    } else {
      /*
       * Não cabe inteiro em nenhum lado, e é o caso do painel de mensagens numa
       * janela baixa com o menu aberto. Escolhe o lado com mais espaço e deixa o
       * menu rolar dentro de si (`max-h` no grid), em vez de empurrar o picker
       * para fora da viewport — que é o que escondia o botão de fechar.
       */
      top = espacoAcima >= espacoAbaixo ? MARGEM : rect.bottom;
      if (top + alturaTotal > window.innerHeight - MARGEM) {
        top = Math.max(MARGEM, window.innerHeight - alturaTotal - MARGEM);
      }
    }

    container.style.top = `${Math.round(top)}px`;
    container.style.left = `${Math.round(left)}px`;
  }, [anchorRef, container, menu, acimaDoBotao]);

  /**
   * Reposiciona no scroll, no resize, e quando abre ou expande.
   *
   * `menu` entra na lista porque é ele que muda a altura total: sem ele na
   * dependência, o primeiro `updatePosition` depois de `showFull` mediria um
   * `menu` ainda `null` e voltaria a posicionar só pela barra — que é
   * exatamente o defeito que a medição completa veio corrigir.
   */
  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, showFull, menu, updatePosition]);

  if (!isOpen) return null;

  const allEmojis = [...new Set([...QUICK_REACTIONS, ...reactions.map((r) => r.emoji)])];

  return (
    <Portal>
      <div
        ref={setContainer}
        className="fixed z-50 transition-opacity duration-150 opacity-100"
        role="group"
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
            ref={setMenu}
            /*
             * `bottom-full` quando o picker ancorou **para cima** da âncora, e
             * `top-full` quando ancorou para baixo.
             *
             * O sinal é a borda inferior do container em relação à âncora: com o
             * menu para cima, o container termina acima do botão. Sem isto o menu
             * desce por cima da barra rápida e do campo de escrever, que é o
             * sintoma reportado.
             *
             * `mb-2`/`mt-2` dão os 8px de folga que o cálculo do `top` já
             * assumiu, para os dois lados baterem.
             */
            className={`absolute left-0 w-72 rounded-xl border border-hairline bg-surface shadow-lg overflow-hidden animate-fade-up z-50 p-2 ${
              acimaDoBotao ? 'bottom-full mb-2' : 'top-full mt-2'
            }`}
            role="dialog"
            aria-label="Todas as reações"
          >
            <p className="text-xs font-medium text-ink-muted mb-2">Escolha uma reação</p>
            {/*
             * `max-h` em `dvh` e não em px, porque o teto tem que acompanhar a
             * janela: um `max-h-60` fixo num monitor de 600px de altura entrega
             * um menu que não cabe em lugar nenhum, e o cálculo acima cai no caso
             * "não cabe inteiro" e deixa o próprio menu rolável. Com `dvh`, o
             * menu encolhe até caber na tela em vez de empurrar o picker para fora.
             */}
            <div className="grid grid-cols-6 gap-1 max-h-[min(15rem,42dvh)] overflow-y-auto">
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