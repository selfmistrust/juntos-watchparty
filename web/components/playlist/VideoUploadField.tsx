import { CloudArrowUp, X } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { hasAllowedVideoExtension } from '@/lib/media';
import { SERVER_URL } from '@/lib/socket';
import type { UploadTokenResult } from '@/hooks/useRoom';
import type { PlaylistItem } from '@/types';

interface Props {
  /** Só quem controla a reprodução pode enviar arquivo — mais restrito que adicionar por link/busca. */
  canControl: boolean;
  requestUploadToken: (payload: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  }) => Promise<UploadTokenResult>;
  onUploaded: (item: Omit<PlaylistItem, 'id' | 'addedBy' | 'addedById'>) => void;
}

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; progress: number }
  | { kind: 'error'; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'Só quem controla a reprodução pode enviar vídeos nesta sala.',
  too_large: 'Esse arquivo passa do limite de tamanho permitido.',
  unsupported_type: 'Só são aceitos arquivos .mp4, .webm ou .mkv.',
  rate_limited: 'Calma aí — espera um instante antes de enviar outro vídeo.',
  no_room: 'Você não está em nenhuma sala no momento.',
  offline: 'Sem conexão com o servidor. Tente de novo.',
  invalid_or_expired_token: 'O envio demorou para começar e expirou. Tente de novo.',
  upload_failed: 'O envio falhou. Verifique sua conexão e tente de novo.',
};

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Não foi possível enviar o vídeo.';
}

export function VideoUploadField({ canControl, requestUploadToken, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });

  if (!canControl) return null;

  const reset = () => {
    setState({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = async (file: File) => {
    if (!hasAllowedVideoExtension(file.name)) {
      setState({ kind: 'error', message: errorMessage('unsupported_type') });
      return;
    }

    setState({ kind: 'uploading', fileName: file.name, progress: 0 });

    const tokenRes = await requestUploadToken({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    });
    if (!tokenRes.ok) {
      setState({ kind: 'error', message: errorMessage(tokenRes.error) });
      return;
    }

    const form = new FormData();
    form.append('file', file);

    try {
      // XMLHttpRequest em vez de fetch: é o único jeito de acompanhar o
      // progresso de envio de um arquivo grande no navegador.
      const result = await new Promise<{ url: string; title: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${SERVER_URL}/api/uploads?token=${encodeURIComponent(tokenRes.token)}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setState({ kind: 'uploading', fileName: file.name, progress: Math.round((e.loaded / e.total) * 100) });
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error('bad_response'));
            }
          } else {
            let code = 'upload_failed';
            try {
              code = JSON.parse(xhr.responseText)?.error ?? code;
            } catch {
              // resposta não era JSON — mantém o motivo genérico
            }
            reject(new Error(code));
          }
        };
        xhr.onerror = () => reject(new Error('upload_failed'));
        xhr.send(form);
      });

      onUploaded({ kind: 'file', src: result.url, title: result.title || file.name });
      reset();
    } catch (err) {
      const code = err instanceof Error ? err.message : 'upload_failed';
      setState({ kind: 'error', message: errorMessage(code) });
    }
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
          if (file) void handleFile(file);
        }}
      />

      {state.kind === 'uploading' ? (
        <div className="rounded-xl border border-hairline bg-raised p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-2xs text-ink-faint">
            <span className="truncate">{state.fileName}</span>
            <span className="shrink-0 pl-2">{state.progress}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-hover">
            <div
              className="h-full rounded-full bg-accent transition-all duration-150"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-hairline py-2 text-2xs text-ink-faint transition-colors duration-150 hover:border-accent/50 hover:text-ink"
        >
          <CloudArrowUp size={14} />
          Enviar vídeo do computador (.mp4, .webm, .mkv)
        </button>
      )}

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
