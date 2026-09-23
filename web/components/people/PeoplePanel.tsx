import { Crown, Disc, Shuffle, UploadSimple } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { randomAvatarSeed } from '@/lib/avatar';
import { compressAvatarFile } from '@/lib/media';
import type { RoomSnapshot, User } from '@/types';

interface Props {
  state: RoomSnapshot;
  me: User | null;
  isHost: boolean;
  /** id de quem adicionou a faixa que está tocando agora — ganha o badge "DJ". */
  djUserId?: string;
  onSetOpenControl: (open: boolean) => void;
  onSetColor: (color: string) => void;
  onSetAvatar: (avatar: { seed?: string; url?: string }) => void;
}

/** Paleta livre pra escolha de cor — mais ampla que a atribuída automaticamente no join. */
const PROFILE_COLORS = [
  '#A78BFA',
  '#7DD3FC',
  '#5EEAD4',
  '#FCA5A5',
  '#FCD34D',
  '#F9A8D4',
  '#86EFAC',
  '#C4B5FD',
  '#FDBA74',
  '#38BDF8',
];

export function PeoplePanel({ state, me, isHost, djUserId, onSetOpenControl, onSetColor, onSetAvatar }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await compressAvatarFile(file);
      onSetAvatar({ url: dataUrl });
    } catch {
      // Se a leitura falhar, o avatar simplesmente permanece o de antes.
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {me && (
        <div className="border-b border-hairline p-4">
          <p className="text-2xs uppercase tracking-wide text-ink-faint">Seu perfil</p>

          <div className="mt-3 flex items-center gap-3">
            <Avatar name={me.name} color={me.color} avatarSeed={me.avatarSeed} avatarUrl={me.avatarUrl} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="truncate text-sm text-ink">{me.name}</span>
              <div className="flex flex-wrap gap-1.5">
                {PROFILE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Usar cor ${c}`}
                    onClick={() => onSetColor(c)}
                    className="h-5 w-5 shrink-0 rounded-full transition-transform duration-150 ease-out hover:scale-110"
                    style={{
                      backgroundColor: c,
                      boxShadow: me.color.toLowerCase() === c.toLowerCase() ? `0 0 0 2px #08080A, 0 0 0 3.5px ${c}` : undefined,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onSetAvatar({ seed: randomAvatarSeed(), url: '' })}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-raised text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink"
            >
              <Shuffle size={13} />
              Novo avatar
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => uploadPhoto(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-raised text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink disabled:opacity-50"
            >
              <UploadSimple size={13} />
              {uploading ? 'Enviando…' : 'Usar foto'}
            </button>
          </div>
        </div>
      )}

      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {state.users.map((user) => (
          <li key={user.id} className="flex items-center gap-3 rounded-lg p-2 transition-colors duration-150 hover:bg-hover">
            <Avatar name={user.name} color={user.color} avatarSeed={user.avatarSeed} avatarUrl={user.avatarUrl} />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">
              {user.name}
              {user.id === me?.id && <span className="ml-1.5 text-2xs text-ink-faint">você</span>}
            </span>
            {djUserId === user.id && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-2xs text-ink-muted">
                <Disc size={11} weight="fill" />
                DJ
              </span>
            )}
            {state.hostId === user.id && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-2xs text-accent">
                <Crown size={11} weight="fill" />
                host
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="border-t border-hairline p-4">
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span>
            <span className="block text-sm text-ink">Todos podem controlar</span>
            <span className="mt-0.5 block text-2xs leading-relaxed text-ink-faint">
              {isHost
                ? 'Libera play, pause e fila para qualquer participante.'
                : 'Só o host muda esta opção.'}
            </span>
          </span>
          <input
            type="checkbox"
            checked={state.openControl}
            disabled={!isHost}
            onChange={(e) => onSetOpenControl(e.target.checked)}
            className="peer sr-only"
          />
          <span className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-white/12 transition-colors duration-200 ease-out peer-checked:bg-accent peer-disabled:opacity-40 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform after:duration-200 after:ease-out peer-checked:after:translate-x-4" />
        </label>
      </div>
    </div>
  );
}
