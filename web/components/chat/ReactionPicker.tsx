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

/** Margem mínima entre o painel e a borda da viewport. */
const MARGEM = 8;
/** Distância entre o painel e o botão de reação. */
const FOLGA = 6;

type Lado = 'cima' | 'baixo';

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
   * De qual lado da âncora o conjunto foi ancorado.
   *
   * É estado, e não algo derivado do CSS, porque a **ordem** dos filhos muda com
   * o lado: ancorado para cima, o painel vem antes da barra no DOM, para que a
   * barra — que encosta no botão — fique por baixo dele.
   */
  const [lado, setLado] = useState<Lado>('cima');
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
   * Detecção de colisão: um elemento medido, dois lados tentados, eixo duplo.
   *
   * ## Por que a medição é do conjunto inteiro
   *
   * A versão anterior media a barra rápida e posicionava o menu — que é
   * `absolute` dentro dela — por conta própria. O menu não contava na medição, e
   * o cálculo dizia "cabe acima" com folga de 40px, para um menu de 200px que
   * aparecia em cima da barra de escrever e cortado pela viewport.
   *
   * Aqui não existe posicionamento interno: barra e painel são irmãos num `flex`
   * vertical, e o container é a **caixa dos dois**. Uma medição, um posicionamento,
   * e não há como os dois discordarem entre si.
   *
   * ## A ordem das tentativas
   *
   * Acima primeiro, porque é o lado com menos chance de cobrir o campo de
   * escrever e a barra do player. Se o conjunto não couber acima, desce. Se não
   * couber em nenhum dos dois — o caso de uma janela baixa com o painel aberto —
   * fica no lado com mais espaço, encostado na margem, e o **grid** rola dentro
   * de si. Nunca o conjunto inteiro: é o grid que tem teto de altura, então
   * sobra sempre espaço para ele aparecer inteiro.
   */
  const updatePosition = useCallback(() => {
    const ancora = anchorRef.current;
    const el = container;
    if (!ancora || !el) return;

    const a = ancora.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();

    const espacoAcima = a.top - FOLGA;
    const espacoAbaixo = window.innerHeight - a.bottom - FOLGA;

    let proximoLado: Lado;
    let y: number;
    if (height <= espacoAcima) {
      proximoLado = 'cima';
      y = a.top - height - FOLGA;
    } else if (height <= espacoAbaixo) {
      proximoLado = 'baixo';
      y = a.bottom + FOLGA;
    } else {
      proximoLado = espacoAcima >= espacoAbaixo ? 'cima' : 'baixo';
      y = proximoLado === 'cima' ? MARGEM : window.innerHeight - height - MARGEM;
    }
    // Rede de segurança para um `height` maior que a própria viewport, que
    // acontece com o painel aberto numa janela muito baixa. Sem isto o topo
    // ficaria negativo e o painel apareceria cortado em cima.
    y = Math.min(Math.max(MARGEM, y), Math.max(MARGEM, window.innerHeight - height - MARGEM));

    /*
     * Eixo horizontal: o canto direito do painel alinhado com o do botão.
     *
     * O botão de reação fica no fim da linha da mensagem, encostado na direita,
     * e alinhar pela **borda** é o que faz o painel parecer preso nele. Centralizar
     * no botão — o que a versão anterior fazia — deixa o painel estendido para
     * a esquerda por cima do texto da mensagem, que é a sobreposição reportada.
     */
    let x = a.right - width;
    const maxX = window.innerWidth - MARGEM - width;
    x = Math.min(Math.max(MARGEM, x), maxX);
    // Se o painel for mais largo que a janela menos as margens, `maxX` fica
    // negativo e a linha acima devolveria a margem em vez de uma posição
    // impossível.
    if (maxX < MARGEM) x = MARGEM;

    /*
     * `transform` e não `top`/`left`.
     *
     * O elemento é `fixed` em 0,0 e anda por `translate3d`. A diferença que
     * importa não é estética: escrever `left` num elemento `fixed` a cada
     * `pointermove` ou `scroll` do chat força um layout do documento inteiro a
     * cada quadro, e `translate3d` roda só na composição. Num picker que se
     * reposiciona durante a rolagem, isso é a diferença entre o chat ficar
     * liso e ficar travado.
     */
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;

    if (proximoLado !== lado) setLado(proximoLado);
  }, [anchorRef, container, lado]);

  /**
   * Reposiciona no scroll, no resize, e quando abre ou expande.
   *
   * `showFull` entra porque é ele que muda a altura do container: sem ele na
   * dependência, o `updatePosition` seguinte mediria a barra sozinha e ancoraria
   * no lugar errado — que é o que fazia o painel aparecer colado no topo da tela
   * quando alguém clicava em `⋯` numa mensagem do fim.
   */
  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();

    // `true` no capture: o scroll do chat acontece num ancestral, e sem capture
    // o listener não veria.
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, showFull, updatePosition]);

  if (!isOpen) return null;

  const allEmojis = [...new Set([...QUICK_REACTIONS, ...reactions.map((r) => r.emoji)])];

  const painel = showFull && (
    <div
      /*
       * `w-80` são 320px e `max-h-80` são 320px, o teto que a especificação
       * pediu. O teto vale para a **caixa**: o grid é `flex-1` com `min-h-0`,
       * então ele recebe o que sobrar e rola sozinho. Um `max-h` no grid
       * deixaria o cabeçalho e o padding somados ao teto, e o conjunto passaria
       * do limite.
       */
      className="flex max-h-80 w-80 flex-col overflow-hidden rounded-xl border border-hairline bg-surface p-2 shadow-lg"
      role="dialog"
      aria-label="Todas as reações"
    >
      <p className="mb-1.5 shrink-0 text-2xs font-medium text-ink-faint">Escolha uma reação</p>
      {/*
       * `min-h-0` é obrigatório num item `flex` com `overflow-y-auto`: sem ele o
       * grid não encolhe abaixo do conteúdo e o pai estoura em vez de rolar.
       *
       * O `scroll-thin` é a classe de scrollbar do projeto; sem ela a barra
       * nativa do Windows aparece com 17px e come duas colunas de emoji.
       */}
      <div className="scroll-thin grid min-h-0 flex-1 grid-cols-8 gap-0.5 overflow-y-auto">
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
              aria-label={count > 0 ? `${emoji} ${count} reações` : `Reagir com ${emoji}`}
              aria-pressed={hasCurrentUser}
              className={`flex h-9 flex-col items-center justify-center rounded-md transition-colors ${
                hasCurrentUser
                  ? 'bg-accent-soft text-accent'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <span className="text-xl leading-none">{emoji}</span>
              {/*
               * A contagem ocupa a linha **sempre**, mesmo valendo zero, e sai
               * invisível quando não há. Sem isso a célula de quem tem reação
               * fica mais alta que a de quem não tem, e as linhas do grid ficam
               * tortas — que é o desalinhamento que o `⋯` sem rótulo resolveu
               * na barra e que aqui voltaria pela outra porta.
               */}
              <span
                className={`text-[0.625rem] font-medium leading-none ${
                  count > 0 ? (hasCurrentUser ? 'text-accent' : 'text-ink-faint') : 'invisible'
                }`}
              >
                {count > 0 ? count : '0'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const barra = (
    <div className="flex items-center gap-0.5 rounded-xl border border-hairline bg-surface px-1.5 py-1 shadow-lg">
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
            aria-label={`${emoji} ${count > 0 ? `${count} reações` : 'sem reações'}`}
            aria-pressed={hasCurrentUser}
            className={`flex h-8 w-8 flex-col items-center justify-center rounded-full transition-colors ${
              hasCurrentUser ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <span className="text-base leading-none">{emoji}</span>
            {count > 0 && (
              <span
                className={`text-[0.625rem] font-medium leading-none ${
                  hasCurrentUser ? 'text-accent' : 'text-ink-faint'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}

      {/*
       * Só o ícone, sem o rótulo "mais" embaixo.
       *
       * O rótulo alinhava a célula, e alinhamento é o que não pode continuar:
       * cada emoji mostra a contagem embaixo quando tem reações, e a célula do
       * botão ficava alta sozinha quando não tinha.
       *
       * O `aria-label` continua nomeando a ação, que é quem precisa do nome
       * para quem não vê o glifo.
       */}
      <button
        type="button"
        role="menuitem"
        onClick={() => setShowFull((prev) => !prev)}
        aria-label={showFull ? 'Menos reações' : 'Mais reações'}
        aria-expanded={showFull}
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-hover hover:text-ink"
      >
        <span className="text-lg leading-none">⋯</span>
      </button>
    </div>
  );

  return (
    <Portal>
      {/*
       * Um container só, em `fixed` no 0,0, movido por `transform` — e `flex-col`
       * para que barra e painel sejam **irmãos** empilhados, nunca um `absolute`
       * dentro do outro.
       *
       * A ordem dos filhos segue o lado: ancorado acima, o painel vem primeiro
       * para ficar por cima da barra, e a barra — que é quem encosta no botão —
       * por baixo. Invertido, o painel apareceria entre o botão e a barra, ou
       * cobrindo a própria barra.
       */}
      <div
        ref={setContainer}
        className={`fixed left-0 top-0 z-50 flex flex-col gap-1.5 will-change-transform ${lado === 'cima' ? '' : 'flex-col-reverse'}`}
        role="group"
        aria-label="Reações"
      >
        {lado === 'cima' ? (
          <>
            {painel}
            {barra}
          </>
        ) : (
          <>
            {barra}
            {painel}
          </>
        )}
      </div>
    </Portal>
  );
}
