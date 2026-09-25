import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { JoinGate } from '@/components/JoinGate';
import { PasswordGate } from '@/components/PasswordGate';
import { RoomHeader } from '@/components/RoomHeader';
import { Sidebar } from '@/components/Sidebar';
import { VideoStage } from '@/components/player/VideoStage';
import { useRoom } from '@/hooks/useRoom';

const NAME_KEY = 'juntos:name';
const AVATAR_SEED_KEY = 'juntos:avatarSeed';
const AVATAR_URL_KEY = 'juntos:avatarUrl';
const COLOR_KEY = 'juntos:color';

export default function RoomPage() {
  const router = useRouter();
  const roomId = typeof router.query.id === 'string' ? router.query.id : '';

  const [name, setName] = useState('');
  const [avatarSeed, setAvatarSeed] = useState<string | undefined>();
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /** Nome e avatar ficam salvos para quem volta à mesma aba não escolher de novo. */
  useEffect(() => {
    const storedName = window.localStorage.getItem(NAME_KEY);
    if (storedName) setName(storedName);
    const storedSeed = window.localStorage.getItem(AVATAR_SEED_KEY);
    if (storedSeed) setAvatarSeed(storedSeed);
    const storedUrl = window.localStorage.getItem(AVATAR_URL_KEY);
    if (storedUrl) setAvatarUrl(storedUrl);
  }, []);

  const join = (value: string, avatar: { seed: string; url?: string }) => {
    window.localStorage.setItem(NAME_KEY, value);
    window.localStorage.setItem(AVATAR_SEED_KEY, avatar.seed);
    if (avatar.url) window.localStorage.setItem(AVATAR_URL_KEY, avatar.url);
    else window.localStorage.removeItem(AVATAR_URL_KEY);
    setName(value);
    setAvatarSeed(avatar.seed);
    setAvatarUrl(avatar.url);
  };

  const {
    connected,
    me,
    state,
    feed,
    typingUsers,
    notice,
    joinError,
    retryPassword,
    isHost,
    canControl,
    currentItem,
    targetPosition,
    reactions,
    actions,
  replyingTo,
  } = useRoom({ roomId, name, enabled: Boolean(roomId && name), avatarSeed, avatarUrl });

  /**
   * Troca de nome ou avatar feita depois de já estar na sala (painel de
   * pessoas) só passa pelo socket — sem isso aqui, ela nunca volta pro
   * localStorage nem pro estado desta página. Reabrir a aba (comum no
   * celular, que descarta abas em segundo plano) voltaria a mandar o nome ou
   * avatar antigo salvo na entrada, entrando em conflito com o que já estava
   * valendo.
   */
  const COLOR_KEY = 'juntos:color';

  useEffect(() => {
    if (!me) return;
    if (me.name !== name) {
      setName(me.name);
      window.localStorage.setItem(NAME_KEY, me.name);
    }
    if (me.avatarSeed !== avatarSeed) {
      setAvatarSeed(me.avatarSeed);
      window.localStorage.setItem(AVATAR_SEED_KEY, me.avatarSeed);
    }
    if (me.avatarUrl !== avatarUrl) {
      setAvatarUrl(me.avatarUrl);
      if (me.avatarUrl) window.localStorage.setItem(AVATAR_URL_KEY, me.avatarUrl);
      else window.localStorage.removeItem(AVATAR_URL_KEY);
    }
    if (me.color && me.color !== window.localStorage.getItem(COLOR_KEY)) {
      window.localStorage.setItem(COLOR_KEY, me.color);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  if (!roomId) return null;
  if (!name) return <JoinGate roomId={roomId} onJoin={join} />;

  if (joinError && !state) {
    return <PasswordGate roomId={roomId} error={joinError} onSubmit={retryPassword} />;
  }

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-sm text-ink-faint">Entrando na sala…</p>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <RoomHeader
        state={state}
        connected={connected}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />

      {/* Mobile: vídeo no topo, chat empilhado logo abaixo, página rola se precisar.
          Desktop: vídeo ocupa o espaço restante à esquerda, painel fixo à direita. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <main className="flex shrink-0 flex-col p-3 lg:min-h-0 lg:flex-1 lg:p-0">
          <VideoStage
            state={state}
            currentItem={currentItem}
            canControl={canControl}
            targetPosition={targetPosition}
            actions={actions}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            reactions={reactions}
          />
          {currentItem && (
            <div className="shrink-0 px-1 pt-3 lg:px-5 lg:pb-4">
              <h1 className="line-clamp-1 text-sm text-ink">{currentItem.title}</h1>
              <p className="mt-0.5 text-2xs text-ink-faint">
                adicionado por {currentItem.addedBy}
                {!canControl && ' · só o host controla a reprodução'}
              </p>
            </div>
          )}
        </main>

        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          state={state}
          me={me}
          feed={feed}
          typingUsers={typingUsers}
          actions={actions}
          canControl={canControl}
          isHost={isHost}
          replyingTo={replyingTo}
        />
      </div>

      {notice && (
        <div className="animate-fade-up pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-hairline bg-raised px-4 py-2.5 text-sm text-ink shadow-lift">
          {notice}
        </div>
      )}
    </div>
  );
}
