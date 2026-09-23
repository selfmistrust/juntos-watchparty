import { CloudArrowUp, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { hasAllowedVideoExtension } from '@/lib/media';
import type { PlaylistItem } from '@/types';

interface Props {
  /** Só quem controla a reprodução pode carregar arquivos. */
  canControl: boolean;
  onUploaded: (item: Omit<PlaylistItem, 'id' | 'addedBy' | 'addedById'>) => void;
}

type UploadState =
  | { kind: 'idle' }
  | { kind: 'error'; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'Só quem controla a reprodução pode selecionar vídeos nesta sala.',
  unsupported_type: 'Só são aceitos arquivos .mp4, .webm ou .mkv.',
};

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Não foi possível carregar o vídeo.';
}

export function VideoUploadField({ canControl, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const previewUrlRef = useRef<string | null>(null);

  const releasePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  };

  useEffect(() => releasePreview, []);

  if (!canControl) return null;

  const reset = () => {
    releasePreview();
    setState({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = (file: File) => {
    if (!hasAllowedVideoExtension(file.name)) {
      setState({ kind: 'error', message: errorMessage('unsupported_type') });
      return;
    }

    // Revoga a URL anterior para não acumular memória
    releasePreview();

    // Cria a URL de objeto local apontando direto para o disco rígido do usuário
    const localUrl = URL.createObjectURL(file);
    previewUrlRef.current = localUrl;

    // Notifica a aplicação para tocar o vídeo localmente e sincronizar via Socket.io
    onUploaded({
      kind: 'file',
      src: localUrl,
      title: file.name,
    });

    setState({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/webm,video/x-matroska,.mp4,.webm,.mkv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-hairline py-2 text-2xs text-ink-faint transition-colors duration-150 hover:border-accent/50 hover:text-ink"
      >
        <CloudArrowUp size={14} />
        Selecionar vídeo do computador
      </button>

      {state.kind === 'error' && (
        <p className="animate-fade-up mt-1.5 flex items-start gap-2 text-2xs leading-relaxed text-live/90">
          <span className="flex-1">{state.message}</span>
          <button type="button" onClick={reset} className="shrink-0 text-ink-faint hover:text-ink">
            <X size={12} />
          </button>
        </p>
      )}
    </div>
  );
}