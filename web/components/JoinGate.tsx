import { PencilSimple, Shuffle, UploadSimple } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { AvatarCropper } from '@/components/ui/AvatarCropper';
import { Button } from '@/components/ui/Button';
import { dicebearUrl, randomAvatarSeed } from '@/lib/avatar';

interface Props {
  roomId: string;
  onJoin: (name: string, avatar: { seed: string; url?: string }) => void;
}

export function JoinGate({ roomId, onJoin }: Props) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => randomAvatarSeed());
  const [photoUrl, setPhotoUrl] = useState<string | undefined>();
  /** Guardado à parte do recorte em si, pra dar pra reabrir o "Ajustar foto" sem pedir o arquivo de novo. */
  const [sourceFile, setSourceFile] = useState<File | undefined>();
  const [cropperOpen, setCropperOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    setSourceFile(file);
    setCropperOpen(true);
    if (fileRef.current) fileRef.current.value = '';
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
          <div className="group relative shrink-0">
            {photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoUrl} alt="Seu avatar" className="h-14 w-14 rounded-full object-cover ring-1 ring-hairline" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={dicebearUrl(seed)} alt="Seu avatar" className="h-14 w-14 rounded-full bg-raised ring-1 ring-hairline" />
            )}
            {photoUrl && sourceFile && (
              <button
                type="button"
                onClick={() => setCropperOpen(true)}
                aria-label="Ajustar foto (zoom e posição)"
                title="Ajustar foto"
                className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-hairline bg-raised text-ink-muted opacity-0 transition-opacity duration-150 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
              >
                <PencilSimple size={12} />
              </button>
            )}
          </div>

          <div className="flex flex-1 gap-2">
            <button
              type="button"
              onClick={() => {
                setPhotoUrl(undefined);
                setSourceFile(undefined);
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
              onChange={(e) => pickPhoto(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-raised text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink"
            >
              <UploadSimple size={13} />
              Usar foto
            </button>
          </div>
        </div>

        {cropperOpen && sourceFile && (
          <AvatarCropper
            file={sourceFile}
            onCancel={() => setCropperOpen(false)}
            onConfirm={(dataUrl) => {
              setPhotoUrl(dataUrl);
              setCropperOpen(false);
            }}
          />
        )}

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
