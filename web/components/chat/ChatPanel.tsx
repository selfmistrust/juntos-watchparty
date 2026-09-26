'use client';

import { Image as ImageIcon, PaperPlaneRight, Sticker, Smiley, ArrowArcLeft } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import { compressImageFile, formatClock } from '@/lib/media';
import { GifPicker } from './GifPicker';
import { EmojiPicker } from './EmojiPicker';
import { ReactionPicker } from './ReactionPicker';
import { ReplyPreview } from './ReplyPreview';
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

  /**
   * Rola até a última mensagem depois que o feed cresce.
   *
   * `scrollIntoView` sem argumento rolava a página inteira no celular, onde o
   * player e o chat dividem a mesma área rolável: a tela saltava para o topo a
   * cada mensagem nova. Rolar o container do feed (`nearest`) mantém o vídeo e
   * os controles no lugar, e só mexe no chat.
   */
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
    onSend(payload);
    setDraft('');
    clearTimeout(typingTimeout.current);
    isTypingRef.current = false;
    onTyping(false);
    if (replyingTo) onCancelReply();
  };

  const pickGif = (gif: GifResult) => {
    onSendGif(gif);
    setGifOpen(false);
  };

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setSendingImage(true);
    try {
      const dataUrl = await compressImageFile(file);
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
      <div data-reaction-bounds className="scroll-thin flex-1 space-y-3 overflow-y-auto px-4 py-4">
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
            <div key={entry.id} className="animate-fade-up flex gap-2.5">
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
                    {entry.text}
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

      <div className="border-t border-hairline p-3">
        {/*
         * A barra é centralizada e com largura limitada, em vez de sangrar de
         * ponta a ponta do painel.
         *
         * Este wrapper também é o âncora de posicionamento dos pickers: eles
         * são `absolute bottom-full left-0 right-0`, e se o `relative`
         * ficasse no container de fora, abririam com a largura da tela cheia
         * enquanto a barra teria 336px — desalinhados na borda direita. Por
         * isso o `relative` desceu para cá, junto do `max-w`.
         */}
        <div className="relative mx-auto w-full max-w-[21rem]">
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
           * `items-center` e não `items-end`: os botões são de 36px e o campo de
           * 32px, então alinhar pelo fundo deixava os ícones pendurados 4px acima
           * do campo. Centralizar é o que alinha as duas fileiras.
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

            <textarea
              ref={draftRef}
              rows={1}
              value={draft}
              onChange={(e) => signalTyping(e.target.value)}
              onKeyDown={(e) => {
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
              className="scroll-thin max-h-28 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:shadow-none"
            />
            <IconButton dense label="Enviar mensagem" onClick={send} disabled={!draft.trim()}>
              <PaperPlaneRight size={17} weight="fill" />
            </IconButton>
          </div>
        </div>
      </div>
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
