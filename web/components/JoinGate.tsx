import { Shuffle, UploadSimple } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { dicebearUrl, randomAvatarSeed } from '@/lib/avatar';
import { compressAvatarFile } from '@/lib/media';

interface Props {
  roomId: string;
  onJoin: (name: string, avatar: { seed: string; url?: string }) => void;
}

export function JoinGate({ roomId, onJoin }: Props) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => randomAvatarSeed());
  const [photoUrl, setPhotoUrl] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      setPhotoUrl(await compressAvatarFile(file));
    } catch {
      // Falha na leitura: fica com o avatar gerado mesmo.
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onJoin(trimmed, { seed, url: photoUrl });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="animate-fade-up w-full max-w-sm">
        <p className="font-mono text-2xs text-ink-faint">sala {roomId}</p>
        <h1 className="mt-2 font-display text-3xl leading-tight tracking-tight text-ink">
          Como te chamamos?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          O nome e o avatar aparecem no chat e na lista de quem está assistindo.
        </p>

        <div className="mt-6 flex items-center gap-3">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="Seu avatar" className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-hairline" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dicebearUrl(seed)} alt="Seu avatar" className="h-14 w-14 shrink-0 rounded-full bg-raised ring-1 ring-hairline" />
          )}

          <div className="flex flex-1 gap-2">
            <button
              type="button"
              onClick={() => {
                setPhotoUrl(undefined);
                setSeed(randomAvatarSeed());
              }}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-raised text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink"
            >
              <Shuffle size={13} />
              Sortear
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
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-raised text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink disabled:opacity-50"
            >
              <UploadSimple size={13} />
              {uploading ? 'Enviando…' : 'Usar foto'}
            </button>
          </div>
        </div>

        <input
          autoFocus
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Seu nome"
          className="mt-4 h-12 w-full rounded-xl border border-hairline bg-raised px-4 text-[0.9375rem] text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-accent/60 focus:outline-none"
        />

        <Button onClick={submit} disabled={!name.trim()} className="mt-3 w-full">
          Entrar na sala
        </Button>
      </div>
    </div>
  );
}
