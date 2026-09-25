import { Image as ImageIcon, PaperPlaneRight, Sticker, Smiley, ArrowArcLeft, ChatTeardrop } from '@phosphor-icons/react';
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
  onSend: (text: string) => void;
  onTyping: (isTyping: boolean) => void;
  onSendGif: (gif: GifResult) => void;
  onSendImage: (dataUrl: string) => void;
  /** Ações para reações e respostas. */
  onReact: (messageId: string, emoji: string) => void;
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
  onReact,
  onReply,
  onCancelReply,
  replyingTo,
}: Props) {
  const [draft, setDraft] = useState('');
  const [gifOpen, setGifOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendingImage, setSendingImage] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>();
  const isTypingRef = useRef(false);
  const emojiAnchorRef = useRef<HTMLButtonElement>(null);
  const reactionAnchorRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const userById = useMemo(() => new Map(users.map((u) => [u.sessionId, u])), [users]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
    onSend(text);
    setDraft('');
    clearTimeout(typingTimeout.current);
    isTypingRef.current = false;
    onTyping(false);
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
      // Leitura/compressão falhou — sem canal próprio de erro aqui; o aviso
      // de "imagem grande demais" do servidor cobre o caso mais comum.
    } finally {
      setSendingImage(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** Converte reactions do formato do servidor (emoji -> {count, users[]}) para o formato do ReactionPicker. */
  const formatReactions = (reactions?: Record<string, { count: number; users: string[] }>) => {
    if (!reactions) return [];
    return Object.entries(reactions).map(([emoji, data]) => ({
      emoji,
      count: data.count,
      users: data.users,
      hasCurrentUser: data.users.includes(me?.sessionId ?? ''),
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
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-4 py-4">
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
          const reactionAnchorKey = entry.id;

          // Preview de resposta (se esta mensagem for uma resposta)
          const showReplyPreview = parentMessage && (
            <ReplyPreview
              key={`reply-preview-${entry.id}`}
              message={parentMessage}
              onCancel={onCancelReply}
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
                  <img
                    src={entry.mediaUrl}
                    alt="Imagem enviada no chat"
                    className="mt-1.5 max-h-52 max-w-[14rem] rounded-lg object-cover ring-1 ring-hairline"
                  />
                ) : entry.kind === 'gif' && entry.mediaUrl ? (
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

                {/* Reações */}
                {entry.reactions && Object.keys(entry.reactions).length > 0 && (
                  <ReactionPicker
                    key={`reactions-${entry.id}`}
                    reactions={formatReactions(entry.reactions)}
                    messageId={entry.id}
                    currentUserId={me?.sessionId ?? ''}
                    onToggle={onReact}
                    anchorRef={{ current: reactionAnchorRefs.current.get(reactionAnchorKey) ?? null } as React.RefObject<HTMLButtonElement | null>}
                    isMobile={typeof window !== 'undefined' && window.innerWidth < 640}
                  />
                )}

                {/* Ações da mensagem (reagir, responder) */}
                <div className="mt-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    ref={(el) => { if (el) reactionAnchorRefs.current.set(reactionAnchorKey, el); }}
                    onClick={() => {
                      // O ReactionPicker abre via anchorRef
                    }}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-2xs text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                    aria-label="Adicionar reação"
                  >
                    <ChatTeardrop size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onReply(entry)}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-2xs text-ink-faint transition-colors hover:bg-hover hover:text-ink"
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

      <div className="relative border-t border-hairline p-3">
        {gifOpen && <GifPicker onPick={pickGif} onClose={() => setGifOpen(false)} />}
        {emojiOpen && (
          <EmojiPicker
            anchorRef={emojiAnchorRef}
            onSelect={(emoji) => {
              const textarea = document.querySelector('textarea');
              if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const newText = draft.slice(0, start) + emoji + draft.slice(end);
                setDraft(newText);
                // Move cursor após o emoji inserido
                setTimeout(() => {
                  textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
                  textarea.focus();
                }, 0);
              }
            }}
            onClose={() => setEmojiOpen(false)}
          />
        )}

        {/* Preview de resposta ativa (quando respondendo a uma mensagem) */}
        {replyingTo && (
          <ReplyPreview
            key="active-reply-preview"
            message={replyingTo}
            onCancel={onCancelReply}
            currentUserName={me?.name}
          />
        )}

        <div className="flex items-end gap-1 rounded-xl border border-hairline bg-raised px-2 py-2 transition-colors duration-150 focus-within:border-accent/60">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickImage(e.target.files?.[0])}
          />
          <IconButton label="Enviar imagem" onClick={() => fileRef.current?.click()} disabled={sendingImage}>
            <ImageIcon size={17} />
          </IconButton>
          <IconButton label="Enviar GIF" active={gifOpen} onClick={() => setGifOpen((v) => !v)}>
            <Sticker size={17} />
          </IconButton>
          <IconButton
            label={emojiOpen ? 'Fechar emojis' : 'Inserir emoji'}
            active={emojiOpen}
            onClick={() => setEmojiOpen((v) => !v)}
            ref={emojiAnchorRef}
          >
            <Smiley size={17} />
          </IconButton>

          <textarea
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
            className="scroll-thin max-h-28 flex-1 resize-none bg-transparent py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <IconButton label="Enviar mensagem" onClick={send} disabled={!draft.trim()}>
            <PaperPlaneRight size={17} weight="fill" />
          </IconButton>
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
