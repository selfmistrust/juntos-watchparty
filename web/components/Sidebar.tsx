import { ChatCircle, ListPlus, Users, X } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { PeoplePanel } from '@/components/people/PeoplePanel';
import { PlaylistPanel } from '@/components/playlist/PlaylistPanel';
import { IconButton } from '@/components/ui/Button';
import { Tabs, type TabDef } from '@/components/ui/Tabs';
import type { RoomActions } from '@/hooks/useRoom';
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
      className={clsx(
        'flex min-w-0 flex-col border-t border-hairline bg-surface',
        'lg:h-full lg:w-[23rem] lg:shrink-0 lg:border-l lg:border-t-0',
        open ? 'min-h-[22rem] flex-1 animate-fade-up lg:min-h-0 lg:flex-none' : 'hidden',
      )}
    >
      <div className="flex items-center gap-2 pr-2 lg:pr-0">
        <div className="min-w-0 flex-1">
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
        </div>
        <IconButton label="Ocultar painel" onClick={onClose} className="lg:hidden">
          <X size={17} />
        </IconButton>
      </div>

      {/* Ações para chat */}

      <div className="min-h-0 flex-1">
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
