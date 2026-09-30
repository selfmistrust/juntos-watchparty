import { ChatCircle, ListPlus, Users, X } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { PeoplePanel } from '@/components/people/PeoplePanel';
import { PlaylistPanel } from '@/components/playlist/PlaylistPanel';
import { IconButton } from '@/components/ui/Button';
import { Tabs, type TabDef } from '@/components/ui/Tabs';
import type { RoomActions } from '@/hooks/useRoom';
import type { StreamController } from '@/hooks/useStreamBridge';
import type { FeedEntry, RoomSnapshot, User, ChatMessage } from '@/types';

type TabId = 'chat' | 'queue' | 'people';

interface Props {
  open: boolean;
  onClose: () => void;
  state: RoomSnapshot;
  me: User | null;
  feed: FeedEntry[];
  typingUsers: string[];
  actions: RoomActions;
  canControl: boolean;
  isHost: boolean;
  replyingTo?: ChatMessage | null;
  /** Ponte de WebRTC, repassada ao painel de tela compartilhada. */
  streamBridge: StreamController;
  /**
   * Largura do painel, em px, controlada pela divisória.
   *
   * `undefined` abaixo de `lg`, onde o layout é empilhado e a largura é da
   * janela — por isso o `style` só entra no `lg`, e no resto a coluna segue
   * `w-[23rem]`.
   */
  largura?: number;
}

export function Sidebar({
  open,
  onClose,
  state,
  me,
  feed,
  typingUsers,
  actions,
  canControl,
  isHost,
  replyingTo,
  streamBridge,
  largura,
}: Props) {
  const [tab, setTab] = useState<TabId>('chat');
  const [unread, setUnread] = useState(0);
  const seenRef = useRef(0);

  const messageCount = feed.filter((f) => f.type === 'message').length;

  /** Quem adicionou a faixa atual — vira o badge "DJ" no chat e na lista de pessoas. */
  const djUserId = state.currentIndex >= 0 ? state.playlist[state.currentIndex]?.addedById : undefined;

  useEffect(() => {
    if (tab === 'chat' && open) {
      seenRef.current = messageCount;
      setUnread(0);
    } else {
      setUnread(Math.max(0, messageCount - seenRef.current));
    }
  }, [messageCount, tab, open]);

  const tabs: TabDef<TabId>[] = [
    { id: 'chat', label: 'Chat', icon: <ChatCircle size={17} />, badge: unread },
    { id: 'queue', label: 'Fila', icon: <ListPlus size={17} />, badge: 0 },
    { id: 'people', label: 'Pessoas', icon: <Users size={17} />, badge: 0 },
  ];

  return (
    <aside
      /*
       * A largura vem **só** da divisória, por `style`, e nada mais a define.
       *
       * Duas fontes de largura no mesmo elemento se brigam em silêncio: a
       * utilitária `w-[23rem]` e o `style` inline. A ordem de cascata resolve
       * — o inline ganha —, mas só enquanto ninguém mexer em nenhuma das duas.
       * Por isso a utilitária aparece **apenas** quando não há largura, e assim
       * existe um dono do valor em cada estado, não dois.
       */
      style={largura ? { width: `${largura}px` } : undefined}
      className={clsx(
        /*
         * `min-w-0` no painel é a condição para a largura ser respeitada. Sem
         * ele, um item flex tem `min-width: auto`, e o conteúdo mais largo estica
         * a coluna **por cima** do `width`: o `style` continua lá, o elemento
         * apenas desobedece. Era o que fazia o chat parecer largo demais dentro de
         * um painel estreito, e não o contrário.
         */
        'flex min-w-0 flex-col border-t border-hairline bg-surface',
        largura ? 'lg:shrink-0' : 'lg:w-[23rem] lg:shrink-0',
        'lg:h-full lg:border-l lg:border-t-0',
        open ? 'min-h-[22rem] flex-1 animate-fade-up lg:min-h-0 lg:flex-none' : 'hidden',
      )}
    >
      {/*
       * A linha das tabs.
       *
       * O `shrink-0` importa: sem ele a linha encolhe quando o painel fica
       * estreito no piso de 320px, e o botão de fechar — que é quem sai no
       * celular — some antes das tabs. No desktop não há botão aqui, e a linha
       * simplesmente ocupa a largura.
       */}
      <div className="flex shrink-0 items-center gap-2 pr-2 lg:pr-0">
        <div className="min-w-0 flex-1">
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
        </div>
        <IconButton label="Ocultar painel" onClick={onClose} className="lg:hidden">
          <X size={17} />
        </IconButton>
      </div>

      {/* Ações para chat */}

      {/*
       * O corpo do painel, onde mora a aba ativa.
       *
       * `min-w-0` é o que impede a aba de esticar o painel. Num item flex
       * vertical o padrão também é `min-height: auto`, e o mesmo vale na
       * horizontal: sem o `min-w-0`, o conteúdo mais largo — a barra do composer
       * com o botão de enviar, o `ReplyPreview` — empurra a coluna para fora em vez
       * de encolher.
       *
       * E `min-h-0` no eixo vertical é o que deixa a área de mensagens rolar
       * dentro de si em vez de esticar a lateral inteira.
       */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {tab === 'chat' && (
          <ChatPanel
            feed={feed}
            me={me}
            users={state.users}
            hostId={state.hostId}
            djUserId={djUserId}
            typingUsers={typingUsers}
            onSend={actions.sendMessage}
            onTyping={actions.setTyping}
            onSendGif={actions.sendGif}
            onSendImage={actions.sendImage}
            onToggleReaction={actions.toggleReaction}
            onReply={actions.reply}
            onCancelReply={actions.cancelReply}
            replyingTo={replyingTo ?? null}
          />
        )}
        {tab === 'queue' && (
          <PlaylistPanel
            playlist={state.playlist}
            currentIndex={state.currentIndex}
            canControl={canControl}
            onAdd={actions.addToPlaylist}
            onRemove={actions.removeFromPlaylist}
            onReorder={actions.reorderPlaylist}
            onSelect={actions.selectTrack}
            requestUploadToken={actions.requestUploadToken}
            streamBridge={streamBridge}
          />
        )}
        {tab === 'people' && (
          <PeoplePanel
            state={state}
            me={me}
            isHost={isHost}
            djUserId={djUserId}
            onSetOpenControl={actions.setOpenControl}
            onSetColor={actions.setColor}
            onSetAvatar={actions.setAvatar}
            onSetName={actions.setName}
          />
        )}
      </div>
    </aside>
  );
}
