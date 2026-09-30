'use client';

import { Image as ImageIcon, PaperPlaneRight, Sticker, Smiley, ArrowArcLeft } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import { compressImageFile, formatClock } from '@/lib/media';
import { MentionAutocomplete } from './MentionAutocomplete';
import { MentionText } from './MentionText';
import { UserProfile } from './UserProfile';
import { GifPicker } from './GifPicker';
import { EmojiPicker } from './EmojiPicker';
import { ReactionPicker } from './ReactionPicker';
import { ReplyPreview } from './ReplyPreview';
import { destravarSomDeMencao } from '@/lib/mentionSound';
import { mencaoPendente, sugerir } from '@/lib/mentionHighlight';
import type { FeedEntry, GifResult, User, ChatMessage } from '@/types';

interface Props {
  feed: FeedEntry[];
  me: User | null;
  /** Usado só pra achar avatar/badge de quem mandou cada mensagem. */
  users: User[];
  hostId: string | null;
  /** id de quem adicionou a faixa que está tocando agora — ganha o badge "DJ". */
  djUserId?: string;
  typingUsers: string[];
  onSend: (payload: { kind?: 'text' | 'gif' | 'image'; text?: string; mediaUrl?: string; parentMessageId?: string }) => void;
  onTyping: (isTyping: boolean) => void;
  onSendGif: (gif: GifResult) => void;
  onSendImage: (dataUrl: string) => void;
  /** Ações para reações e respostas. */
  onToggleReaction: (messageId: string, emoji: string) => void;
  onReply: (message: ChatMessage) => void;
  onCancelReply: () => void;
  /** Mensagem que está sendo respondida (se houver). */
  replyingTo?: ChatMessage | null;
}

export function ChatPanel({
  feed,
  me,
  users,
  hostId,
  djUserId,
  typingUsers,
  onSend,
  onTyping,
  onSendGif,
  onSendImage,
  onToggleReaction,
  onReply,
  onCancelReply,
  replyingTo,
}: Props) {
  const [draft, setDraft] = useState('');
  const [gifOpen, setGifOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendingImage, setSendingImage] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>();
  const isTypingRef = useRef(false);
  const emojiAnchorRef = useRef<HTMLButtonElement>(null);
  /**
   * Âncoras do ReactionPicker, uma por mensagem. Precisam ser objetos
   * estáveis — passar `{ current: elemento }` inline criaria um ref novo a
   * cada render, o que quebraria o `useCallback` de posicionamento dentro do
   * picker e remontaria os listeners de scroll/resize a cada tecla digitada.
   */
  const reactionAnchors = useRef<Map<string, { current: HTMLButtonElement | null }>>(new Map());

  /**
   * O campo cresce com o texto, até o teto do CSS.
   *
   * Sem isto o `max-h-28` não servia para nada: o `textarea` ficava nos 32px
   * do `rows={1}` para sempre, e uma mensagem longa **rolava dentro do campo** —
   * medi no celular a 390px: 32px de altura, 164px de largura, 22 caracteres
   * visíveis, com o texto digitado escondido atrás de uma barra de rolagem
   * minúscula. No desktop passa despercebido porque o campo é largo; no
   * celular a pessoa escreve às cegas.
   *
   * O truque é o `height: auto` antes de medir: sem ele o `scrollHeight` seria
   * o da altura já fixada, e o campo nunca cresceria. O `max-h` do CSS segura
   * o teto — passando dele, `scrollHeight` continua crescendo e o campo volta
   * a rolar, que é o comportamento certo no limite.
   *
   * `useEffect` e não `useLayoutEffect` de propósito: este roda no servidor
   * no SSR do Next e causaria aviso de hydration. O salto de um quadro é
   * invisível porque o texto aparece uma tecla por vez.
   */
  useEffect(() => {
    const ta = draftRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft]);

  /** Devolve (criando na primeira vez) o ref estável da âncora de uma mensagem. */
  const getReactionAnchor = (messageId: string) => {
    let anchor = reactionAnchors.current.get(messageId);
    if (!anchor) {
      anchor = { current: null };
      reactionAnchors.current.set(messageId, anchor);
    }
    return anchor;
  };

  const userById = useMemo(() => new Map(users.map((u) => [u.sessionId, u])), [users]);

  /*
   * Autocomplete de menções.
   *
   * O estado é derivado do texto, não mantido à parte: quem digita `@Ma` faz a
   * lista aparecer, e quem apaga a letra faz sumir. Guardar a lista num estado
   * paralelo exigiria sincronizar dois — e a divergência seria "a lista continua
   * aberta depois de eu apagar o @".
   *
   * `indiceAtivo` é a exceção que precisa de estado: ele muda com o `ArrowDown` e
   * não é função do texto.
   *
   * A si próprio não entra na lista. Menção a si mesmo não gera som nem
   * notificação — o servidor nem resolve — então oferecer a si próprio seria
   * sugerir algo que não acontece.
   */
  const [indiceAtivo, setIndiceAtivo] = useState(0);
  const [perfilAberto, setPerfilAberto] = useState<string | null>(null);
  const cursorRef = useRef(0);

  const candidatos = useMemo(
    () => (me ? users.filter((u) => u.sessionId !== me.sessionId) : users),
    [users, me],
  );

  const mencaoAberta = useMemo(() => {
    const antes = draft.slice(0, cursorRef.current);
    const pendente = mencaoPendente(antes);
    if (!pendente) return null;
    const lista = sugerir(pendente.consulta, candidatos);
    return lista.length > 0 ? { ...pendente, lista } : null;
    // `cursorRef` é ref de propósito: ele muda sem render, e o `draft` já muda
    // a cada tecla, então a dependência do texto cobre o recálculo.
  }, [draft, candidatos]);

  /*
   * A lista reabre no primeiro item quando o texto muda. Sem isto, aceitar
   * "Maria" e seguir digitando deixaria o índice apontando para a posição 5 de
   * uma lista de 2 — e o `Enter` mandaria a pessoa errada.
   */
  useEffect(() => {
    setIndiceAtivo(0);
  }, [mencaoAberta?.consulta, mencaoAberta?.inicio]);

  /**
   * Aceita a sugestão: troca o `@parcial` já digitado por `@Nome Completo `.
   *
   * O espaço final é deliberado. Sem ele, `@Maria` seguido de `olá` vira
   * `@Mariaolá`, que não casa com nome nenhum e a menção morre — a pessoa não
   * recebe som nem notificação e não entende por quê.
   */
  const aceitarMencao = useCallback(
    (user: User) => {
      const inicio = mencaoAberta?.inicio;
      if (inicio === undefined) return;
      const ateCursor = cursorRef.current;
      const novo = draft.slice(0, inicio) + '@' + user.name + ' ' + draft.slice(ateCursor);
      setDraft(novo);
      setIndiceAtivo(0);
      const posicao = inicio + user.name.length + 2;
      cursorRef.current = posicao;
      // O cursor precisa ir para depois do espaço: sem isto, o próximo caractere
      // digitado entra antes do nome e o `@Maria` fica `@Mar` + `ia`.
      requestAnimationFrame(() => {
        const ta = draftRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(posicao, posicao);
      });
    },
    [draft, mencaoAberta],
  );

  /**
   * O cursor é lido do DOM, e não inferido do texto: o valor do textarea é
   * controlado pelo React, mas a posição do cursor é do navegador. Inferir de
   * `draft.length` colocaria a detecção de `@` no fim da frase mesmo com o
   * cursor no meio, e o autocomplete apareceria no lugar errado.
   */
  const lerCursor = () => {
    cursorRef.current = draftRef.current?.selectionStart ?? draft.length;
  };

  const abrirPerfil = useCallback(
    (sessionId: string) => {
      // Só abre para quem está na sala agora. O `userById` é a lista viva, e
      // clicar num nome de quem já saiu não tem o que mostrar.
      if (!userById.has(sessionId)) return;
      setPerfilAberto(sessionId);
    },
    [userById],
  );

  /**
   * Rola até a última mensagem depois que o feed cresce.
   *
   * `scrollIntoView` sem argumento rolava a página inteira no celular, onde o
   * player e o chat dividem a mesma área rolável: a tela saltava para o topo a
   * cada mensagem nova. Rolar o container do feed (`nearest`) mantém o vídeo e
   * os controles no lugar, e só mexe no chat.
   */
  /**
   * Pula para o fim do feed, sem animação.
   *
   * ## Por que o envio não pode ser suave
   *
   * O efeito que rola a cada mensagem usa `smooth`, e isso é certo para quem
   * *recebe*: a mensagem nova entra logo abaixo e o deslocamento é de uma linha.
   *
   * No envio é o oposto. A pessoa estava lendo o meio do histórico, aperta Enter,
   * e o `smooth` anima a travessia inteira — dezenas de mensagens subindo, por
   * um segundo e meio, com a entrada dela no fim. O movimento é lento o bastante
   * para parecer travamento, e a pessoa não sabe se a mensagem entrou.
   *
   * `auto` corta: o feed vai direto ao fim e a mensagem aparece no lugar. O
   * efeito suave ainda roda quando a mensagem chega pelo socket, e aí o
   * deslocamento é de uma linha, que é o que `smooth` faz bem.
   *
   * O alvo é o mesmo sentinela do efeito — `endRef`, a marca de fim do feed.
   * Rolar até a última mensagem *renderizada* é o que dá: no instante do envio a
   * mensagem ainda não chegou pelo socket, e esperar por ela deixaria a pessoa
   * olhando para o rodapé sem resposta nenhuma.
   */
  const pularParaOFim = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [feed.length, typingUsers.length]);

  const signalTyping = (value: string) => {
    setDraft(value);
    if (!isTypingRef.current && value) {
      isTypingRef.current = true;
      onTyping(true);
    }
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      isTypingRef.current = false;
      onTyping(false);
    }, 1400);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const payload: { kind: 'text'; text: string; parentMessageId?: string } = {
      kind: 'text',
      text,
    };
    if (replyingTo) {
      payload.parentMessageId = replyingTo.id;
    }
    /*
     * O salto vem **antes** do `onSend`.
     *
     * A ordem importa pouco para o efeito (que só roda quando o feed cresce), mas
     * importa para quem vê: pulando primeiro, a rolagem acontece no mesmo frame
     * do clique, junto com o campo esvaziando. Se viesse depois, haveria um
     * instante com a mensagem enviada e o histórico ainda no lugar.
     */
    pularParaOFim();
    onSend(payload);
    setDraft('');
    clearTimeout(typingTimeout.current);
    isTypingRef.current = false;
    onTyping(false);
    if (replyingTo) onCancelReply();
  };

  const pickGif = (gif: GifResult) => {
    /*
     * GIF e imagem são mensagem como o texto, e a pessoa que escolheu uma está
     * em outro ponto do histórico — normalmente no topo, logo depois de abrir o
     * picker. Sem o salto, a animação longa voltaria por este caminho.
     */
    pularParaOFim();
    onSendGif(gif);
    setGifOpen(false);
  };

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setSendingImage(true);
    try {
      const dataUrl = await compressImageFile(file);
      pularParaOFim();
      onSendImage(dataUrl);
    } catch {
      // Leitura/compressão falhou — sem canal próprio de erro aqui
    } finally {
      setSendingImage(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /**
   * Converte reactions do formato do servidor para o formato do ReactionPicker.
   * Compara com `userId` (persistente entre reconexões) — e não com
   * `sessionId`, que é o id do socket e muda a cada F5, o que fazia o
   * destaque da própria reação sumir ao recarregar a página.
   */
  const formatReactions = (reactions?: Record<string, { count: number; users: string[] }>) => {
    if (!reactions) return [];
    return Object.entries(reactions).map(([emoji, data]) => ({
      emoji,
      count: data.count,
      users: data.users,
      hasCurrentUser: data.users.includes(me?.userId ?? ''),
    }));
  };

  /** Encontra a mensagem original para reply preview. */
  const findParentMessage = (parentId?: string): ChatMessage | undefined => {
    if (!parentId) return undefined;
    return feed.find(
      (e): e is FeedEntry & { type: 'message' } => e.type === 'message' && e.id === parentId
    ) as ChatMessage | undefined;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">

      {/*
       * A área de mensagens.
       *
       * O `min-w-0` é o que impede a deformação. Num item flex, o tamanho
       * mínimo padrão é `auto`, ou seja, o conteúdo — e uma mensagem com um link
       * longo, uma imagem ou uma palavra sem hífen estica o item e empurra a
       * coluna para fora do painel. Com a divisória, o sintoma era o feed inteiro
       * mais largo que a lateral, e o painel parecendo "espremido" por dentro
       * enquanto transbordava por fora.
       *
       * `min-w-0` + `w-full` = o feed ocupa exatamente o espaço disponível e
       * encolhe junto com ele.
       */}
      <div
        data-reaction-bounds
        className="scroll-thin min-h-0 min-w-0 w-full flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-4 py-4"
      >
        {feed.length === 0 && (
          <p className="pt-6 text-center text-sm text-ink-faint">
            Ninguém falou nada ainda. Comece você.
          </p>
        )}

        {feed.map((entry) => {
          if (entry.type === 'system') {
            return (
              <p key={entry.id} className="animate-fade-up px-1 text-center text-2xs text-ink-faint">
                {entry.text}
              </p>
            );
          }

          const sender = userById.get(entry.userId);
          const isHost = hostId === entry.userId;
          const isDj = djUserId === entry.userId;
          const isOwn = entry.userId === me?.sessionId;
          const parentMessage = findParentMessage(entry.parentMessageId);
          const messageReactions = formatReactions(entry.reactions);
          
          // Show reply preview if message has parentMessagePreview (from backend) or we can find parent message
          const showReplyPreview = (entry.parentMessagePreview || parentMessage) && (
            <ReplyPreview
              key={`reply-preview-${entry.id}`}
              message={
                entry.parentMessagePreview
                  ? {
                      id: entry.parentMessagePreview.id,
                      userId: '',
                      name: entry.parentMessagePreview.name,
                      color: '',
                      kind: 'text' as const,
                      text: entry.parentMessagePreview.text,
                      at: Date.now(),
                    }
                  : parentMessage!
              }
              currentUserName={me?.name}
            />
          );

          return (
            <div key={entry.id} className="animate-fade-up flex min-w-0 gap-2.5">
              <Avatar
                name={entry.name}
                color={entry.color}
                avatarSeed={sender?.avatarSeed}
                avatarUrl={sender?.avatarUrl}
                size="sm"
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                {showReplyPreview}
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span
                    className="truncate text-[0.8125rem] font-medium"
                    style={{ color: isOwn ? undefined : entry.color }}
                  >
                    {isOwn ? 'Você' : entry.name}
                  </span>
                  {isHost && <Badge label="Host" />}
                  {isDj && <Badge label="DJ" />}
                  <time className="shrink-0 font-mono text-2xs text-ink-faint">
                    {formatClock(entry.at)}
                  </time>
                </div>

                {entry.kind === 'image' && entry.mediaUrl ? (
                  // Anexos do chat vêm do object storage com URL já pronta e
                  // dims desconhecidas; passar pelo `next/image` exigiria
                  // largura e altura para reservar o espaço, e aqui não temos
                  // nenhum dos dois antes de carregar.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={entry.mediaUrl}
                    alt="Imagem enviada no chat"
                    className="mt-1.5 max-h-52 max-w-[14rem] rounded-lg object-cover ring-1 ring-hairline"
                  />
                ) : entry.kind === 'gif' && entry.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={entry.mediaUrl}
                    alt={entry.text || 'GIF'}
                    className="mt-1.5 max-h-40 rounded-lg ring-1 ring-hairline"
                  />
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink/90">
                    {/*
                      * O destaque da menção entra por aqui, e este é o único
                      * caminho com texto visível: a legenda de um GIF vai para o
                      * `alt` da imagem, e a de uma imagem não é renderizada. Só
                      * o texto de uma mensagem comum volta a ser lido.
                      */}
                    <MentionText
                      texto={entry.text}
                      participantes={users}
                      mencionados={entry.mentions}
                      aoAbrirPerfil={abrirPerfil}
                    />
                  </p>
                )}

                {/* Reações já dadas — clicar alterna a mesma reação. */}
                {messageReactions.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {messageReactions.map((reaction) => (
                      <button
                        key={reaction.emoji}
                        type="button"
                        onClick={() => onToggleReaction(entry.id, reaction.emoji)}
                        aria-pressed={reaction.hasCurrentUser}
                        aria-label={`${reaction.emoji} ${reaction.count}`}
                        /* Alvo maior só onde o dedo é o ponteiro (ver os botões
                           abaixo). No desktop mantém o chip compacto, para não
                           inflar a lista de reações de cada mensagem. */
                        className={`flex min-h-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3 ${
                          reaction.hasCurrentUser
                            ? 'border-accent/50 bg-accent-soft text-accent'
                            : 'border-hairline bg-raised text-ink-muted hover:border-accent/40 hover:text-ink'
                        }`}
                      >
                        <span>{reaction.emoji}</span>
                        <span className="font-mono tabular-nums">{reaction.count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Picker de reações. Fica montado mesmo sem nenhuma reação
                    na mensagem — se fosse condicionado a `reactions`, o botão
                    de baixo não teria o que abrir justamente na primeira vez,
                    que é quando ele mais importa. */}
                <ReactionPicker
                  isOpen={reactionPickerOpen === entry.id}
                  onClose={() => setReactionPickerOpen(null)}
                  reactions={messageReactions}
                  messageId={entry.id}
                  onToggle={onToggleReaction}
                  anchorRef={getReactionAnchor(entry.id)}
                />

                {/* Ações da mensagem.
                    O alvo grande é por `pointer: coarse`, não por breakpoint de
                    largura: um tablet em retrato tem 834px (acima de `sm`) e
                    ainda é tocado com o dedo. Com `sm:` os botões voltavam a
                    28px justamente nos tablets, que são os piores alvos.
                    `h-11 w-11` = 44px, o mínimo recomendado para toque. */}
                <div className="mt-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    ref={(el) => {
                      getReactionAnchor(entry.id).current = el;
                    }}
                    onClick={() =>
                      setReactionPickerOpen((prev) => (prev === entry.id ? null : entry.id))
                    }
                    aria-expanded={reactionPickerOpen === entry.id}
                    className="flex h-7 w-auto items-center justify-center gap-1 rounded-lg px-2 text-2xs text-ink-faint transition-colors hover:bg-hover hover:text-ink [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:p-0"
                    aria-label="Adicionar reação"
                  >
                    <Smiley size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onReply(entry)}
                    className="flex h-7 w-auto items-center justify-center gap-1 rounded-lg px-2 text-2xs text-ink-faint transition-colors hover:bg-hover hover:text-ink [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:p-0"
                    aria-label="Responder"
                  >
                    <ArrowArcLeft size={13} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="h-5 px-4">
        {typingUsers.length > 0 && (
          <p className="animate-fade-up flex items-center gap-1.5 text-2xs text-ink-faint">
            <span className="flex gap-0.5">
              <Dot delay="0ms" />
              <Dot delay="200ms" />
              <Dot delay="400ms" />
            </span>
            {typingUsers.length === 1
              ? `${typingUsers[0]} está digitando`
              : `${typingUsers.length} pessoas estão digitando`}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline p-3">
        {/*
         * O composer ocupa **toda** a largura interna do painel.
         *
         * Este wrapper tinha `mx-auto` e `max-w-[21rem]`, o que travava a barra em
         * 336px e a centralizava dentro de um painel que vai de 320 a 650px. Com a
         * divisória, o resultado era o campo estreito e deslocado: arrastar para a
         * direita aumentava o painel, e os 336px continuavam no meio, com uma
         * faixa vazia dos dois lados.
         *
         * O `mx-auto` e o `max-w` saíram, e a largura agora é a do pai.
         *
         * O `relative` **fica**, e é o que ancora os pickers de GIF e emoji: eles
         * são `absolute bottom-full left-0 right-0` e precisam abrir com a mesma
         * largura da barra. Com o `max-w` removido, eles passam a acompanhar a
         * largura real — que é o que se quer.
         */}
        <div className="relative w-full">
          {gifOpen && <GifPicker onPick={pickGif} onClose={() => setGifOpen(false)} />}
          {emojiOpen && (
            <EmojiPicker
              anchorRef={emojiAnchorRef}
              onSelect={(emoji) => {
                setDraft((prev) => prev + emoji);
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}

          {replyingTo && (
            <ReplyPreview
              key="active-reply-preview"
              message={replyingTo}
              onCancel={onCancelReply}
              currentUserName={me?.name}
            />
          )}

          {/*
           * `items-center` e não `items-end`.
           *
           * Não é pela diferença de altura: com o `py-2` do campo, os botões e o
           * campo têm os mesmos 36px medidos. É porque o campo **cresce**. Com
           * `items-end` a fileira de ícones encostaria no rodapé da barra e ficaria
           * pendurada no meio de uma frase de quatro linhas; centralizar mantém
           * os ícones no eixo do campo inteiro, que é o que se espera de um campo
           * que cresce.
           *
           * Medido, nas duas situações, com a correção aplicada:
           *
           *   1 linha   barra 54   campo 36   texto 847   icones 847   1 eixo
           *   4 linhas  barra 114  campo 96   texto 817   icones 817   1 eixo
           *
           * Não é uma regra global de `.items-end`: o overlay dos modais e o
           * ReactionDock dependem do comportamento de baixo, e sobrescrever
           * aquilo quebraria o bottom-sheet no celular.
           *
           * `gap-0.5` no lugar de `gap-1`: são quatro ícones numa fileira de
           * 32px, e 4px de respiro entre eles deixava a fileira solta.
           *
           * No celular o respiro externo também aperta (`px-1.5 py-1.5`) e os
           * quatro botões vão para 40px com `dense`. A conta fechava assim: a
           * 390px, os quatro alvos de 44px comiam 176px e o campo ficava com
           * 164px — 22 caracteres visíveis, e o placeholder "Mandar mensagem" já
           * não cabia inteiro. O que resolve de vez é o auto-crescimento do
           * campo, logo abaixo; isto é só para dar mais largura de entrada.
           */}
          <div className="flex items-center gap-0.5 rounded-xl border border-hairline bg-raised px-1.5 py-1.5 transition-colors duration-150 focus-within:border-accent/60 sm:px-2 sm:py-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickImage(e.target.files?.[0])}
            />
            <IconButton dense label="Enviar imagem" onClick={() => fileRef.current?.click()} disabled={sendingImage}>
              <ImageIcon size={17} />
            </IconButton>

            <IconButton
              dense
              label="Enviar GIF"
              active={gifOpen}
              onClick={() => {
                setEmojiOpen(false);
                setGifOpen((v) => !v);
              }}
            >
              <Sticker size={17} />
            </IconButton>

            <IconButton
              ref={emojiAnchorRef}
              dense
              label={emojiOpen ? 'Fechar emojis' : 'Inserir emoji'}
              active={emojiOpen}
              onClick={() => {
                setGifOpen(false);
                setEmojiOpen((v) => !v);
              }}
            >
              <Smiley size={17} />
            </IconButton>

            {/*
              * O campo é um `textarea` comum: texto normal e o caret do navegador.
              *
              * Houve aqui um espelho do texto por baixo do campo, para pintar de
              * roxo a menção enquanto se digita. O alinhamento foi medido e
              * estava exato — mas só à custa de `text-transparent` no campo, e o
              * resultado foi um campo quebrado: caret que não aparecia,
              * digitação estranha, seleção e colar instáveis.
              *
              * A conclusão vale ficar escrita, porque é o ponto que faz alguém
              * tentar de novo: **um `textarea` não sabe colorir parte do próprio
              * texto**, e a técnica do espelho resolve isso tirando o campo de
              * verdade do caminho. Um campo que não digita direito não vale um
              * destaque de meio segundo.
              *
              * O roxo da menção em curso vive na **lista de sugestões**, que é
              * onde o destaque ajuda sem tocar no campo. E na mensagem enviada,
              * pelo `MentionText`.
              */}
            <div className="flex min-w-0 flex-1 items-center">
            <textarea
              ref={draftRef}
              rows={1}
              value={draft}
              onChange={(e) => signalTyping(e.target.value)}
              /*
               * O foco no campo é o gesto que destrava o `AudioContext`.
               *
               * Aqui, e não num listener global de clique no load: o
               * `ReactionDock` registra o `lib/sfx` antigo como removido
               * justamente por causa de um listener que só existia para
               * destravar áudio e nunca era desinstalado. Quem não vai escrever
               * no chat não paga por isso, e não há nada global para vazar.
               */
              onFocus={destravarSomDeMencao}
              onKeyUp={lerCursor}
              onClick={lerCursor}
              /*
               * `aria-autocomplete="list"` diz que o campo completa com uma
               * lista. O `aria-expanded` **não** vai aqui: ele não é aceito no
               * papel implícito de `textbox`, e colocá-lo à força faria o leitor
               * de tela anunciar um estado que ele não sabe interpretar. A
               * lista é anunciada pelo `role="listbox"` do próprio componente.
               */
              aria-autocomplete="list"
              onKeyDown={(e) => {
                /*
                 * Com a lista aberta, as setas e o `Enter` pertencem a ela.
                 *
                 * Sem este desvio, `ArrowDown` no meio de uma frase moveria o
                 * cursor do texto e o `Enter` mandaria a mensagem com `@Ma` pela
                 * metade — que é o pior jeito de um autocomplete existir: ele
                 * atrapalha quem não está usando.
                 */
                if (mencaoAberta) {
                  const total = mencaoAberta.lista.length;
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setIndiceAtivo((atual) => {
                      const passo = e.key === 'ArrowDown' ? 1 : -1;
                      // Dá a volta em vez de travar na ponta: com a lista
                      // aberta, o travamento é só um beco sem saída.
                      return (atual + passo + total) % total;
                    });
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    const escolhido = mencaoAberta.lista[indiceAtivo];
                    if (escolhido) {
                      aceitarMencao(escolhido);
                      return;
                    }
                  }
                  if (e.key === 'Escape') {
                    // Não fecha a lista com um estado próprio: sem `@` no texto
                    // ela some sozinha, e um estado a mais só criaria a
                    // possibilidade de ela reaparecer depois do texto mudar.
                    setDraft((atual) => atual.replace('@', '@ '));
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Mandar mensagem"
              maxLength={600}
              /*
               * `focus-visible:shadow-none` cancela o anel roxo que o
               * `:focus-visible` global desenha em todo campo do app. Aqui ele
               * ficaria *dentro* da barra, que já acende a borda no
               * `focus-within` — dois indicadores de foco aninhados, com raios
               * de canto diferentes. A borda da barra continua sendo o
               * indicador, então a acessibilidade não perde nada.
               */
              /*
               * `block` e `py-2`, e nenhum dos dois é detalhe de estética.
               *
               * ## O `block` é o que alinhava
               *
               * Um `textarea` é `inline-block` por padrão, e o preflight do
               * Tailwind não muda isso. Dentro de um wrapper `block` ele fica
               * sentado na **linha de base** do wrapper, e o espaço de descida
               * dessa linha sobrava embaixo dele.
               *
               * Medido no navegador, com a barra real:
               *
               *   wrapper   display block, 38px, 0px acima do campo, 6px abaixo
               *   campo     inline-block, 32px
               *   texto     centro em 843
               *   icones    centro em 846
               *
               * Dois eixos, 3px de diferença — e `items-center` na barra não
               * corrigia, porque o centro do *elemento* do campo estava
               * centrada, e o texto dentro dele é que não. Com o wrapper em
               * `flex items-center` e o campo em `block`, a descida some:
               *
               *   texto     centro em 847
               *   icones    centro em 847
               *   eixos distintos: 1
               *
               * ## O `py-2` é o que iguala as alturas
               *
               * `py-1.5` dava 20px de linha + 12px de padding = 32px, contra
               * 36px dos botões. `py-2` dá 20 + 16 = **36px**, a mesma altura.
               * Como o auto-crescimento escreve `height = scrollHeight`, e
               * `scrollHeight` inclui o padding, o campo passa a ter a altura dos
               * botões sem nenhum ajuste por linha.
               *
               * ## Sem `line-height` exagerado
               *
               * 20px para 14px de fonte é 1,43 — o mesmo do resto do app. Não
               * era o `line-height` que descentrava o campo; era o `inline-block`
               * somando a descida da linha do wrapper por cima dele.
               */
              /*
               * `min-w-[9rem]` e o piso do campo, e ele substitui o `min-w-0`.
               *
               * Com `min-w-0` o campo encolhe ate zero: os quatro botoes tem
               * `shrink-0` e medem 36px cada, entao num painel estreito eles
               * consomem a barra inteira e o campo fica com algumas dezenas de
               * pixels. A quebra de linha do placeholder em duas linhas, a
               * palavra cortado e aquele tracinho tracejado embaixo -- que e o
               * indicador de transbordo do textarea -- sao todos o mesmo
               * problema: nao e o texto quebrando, e o campo sem largura.
               *
               * Com o piso, o campo nunca some. E se ainda assim a barra nao
               * couber, quem transborda e a barra -- e a pessoa ve a barra
               * cortada, que e um sintoma legivel, em vez de um campo ilegivel.
               *
               * O `max-h-28` e o auto-crescimento: o campo cresce em altura ate
               * 112px e depois rola. E por isso que o `min-w` precisa existir --
               * altura cresce sem limite, largura nao.
               */
              className="scroll-thin block max-h-28 min-w-[9rem] flex-1 resize-none bg-transparent py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
            />
            </div>
            <IconButton dense label="Enviar mensagem" onClick={send} disabled={!draft.trim()}>
              <PaperPlaneRight size={17} weight="fill" />
            </IconButton>
          </div>

          {/*
            * A lista fica dentro do wrapper `relative` da barra, e não solta no
            * painel: é esse wrapper que é a âncora de posicionamento dos pickers,
            * e a lista precisa da mesma largura de 336px da barra. Ancorada no
            * container de fora, abriria com a largura da tela cheia e desalinhada
            * na borda direita.
            */}
          {mencaoAberta && (
            <MentionAutocomplete
              sugestoes={mencaoAberta.lista}
              consulta={mencaoAberta.consulta}
              ativo={indiceAtivo}
              onEscolher={aceitarMencao}
              onVerPerfil={(user) => setPerfilAberto(user.sessionId)}
              onPassarOMouse={setIndiceAtivo}
            />
          )}
        </div>
      </div>

      {/*
        * O perfil de quem foi citado. Fica no fim, sobre tudo, e é o único
        * elemento que sai do fluxo do painel.
        */}
      {perfilAberto && userById.get(perfilAberto) && (
        <UserProfile
          user={userById.get(perfilAberto)!}
          isMe={perfilAberto === me?.sessionId}
          isHost={hostId === perfilAberto}
          onFechar={() => setPerfilAberto(null)}
        />
      )}
    </div>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-accent">
      {label}
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1 w-1 animate-blink rounded-full bg-ink-faint"
      style={{ animationDelay: delay }}
    />
  );
}
