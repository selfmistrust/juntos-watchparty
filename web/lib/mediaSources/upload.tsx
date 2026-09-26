'use client';

import { CloudArrowUp } from '@phosphor-icons/react';
import { hasAllowedVideoExtension } from '@/lib/media';
import type { MediaSourceProvider, MediaSourceContext } from './types';

/** Extensões aceitas — mesma lista de `ALLOWED_VIDEO_EXTENSIONS` e do servidor. */
const ACCEPT = 'video/mp4,video/webm,video/x-matroska,.mp4,.webm,.mkv';

function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^./]+$/, '');
  return (withoutExt || fileName).slice(0, 120);
}

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'Só quem controla a reprodução pode enviar vídeos nesta sala.',
  too_large: 'Esse arquivo passa do limite de tamanho permitido.',
  unsupported_type: 'Só são aceitos arquivos .mp4, .webm ou .mkv.',
  rate_limited: 'Calma aí — espera um instante antes de enviar outro vídeo.',
  no_room: 'Você não está em nenhuma sala no momento.',
  offline: 'Sem conexão com o servidor. Tente de novo.',
  upload_failed: 'O envio falhou. Verifique sua conexão e tente de novo.',
};

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Não foi possível enviar o vídeo.';
}

/**
 * Abre o seletor de arquivos do sistema e resolve com o arquivo escolhido, ou
 * `null` se a pessoa cancelar.
 *
 * O `input` é criado na hora e descartado em seguida: o picker não precisa
 * viver no estado do React, e assim não há "arquivo escolhido" para
 * sincronizar entre o modal e o resto da tela.
 *
 * O `cancel` event existe nos navegadores modernos e resolve esse caso direto;
 * o fallback por `focus` cobre os que não o implementam, senão a promessa
 * ficaria pendurada para sempre quando o diálogo fosse fechado.
 */
function chooseFile(): Promise<File | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.style.display = 'none';

  return new Promise<File | null>((resolve) => {
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });

    // Safari antigo não emite `cancel`; ao voltar o foco sem arquivo, é cancel.
    window.addEventListener(
      'focus',
      () => {
        window.setTimeout(() => {
          if (!input.files?.length) done(null);
        }, 500);
      },
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

export const uploadProvider: MediaSourceProvider = {
  id: 'upload',
  name: 'Computador',
  description: 'Envie um vídeo do seu dispositivo (.mp4, .webm, .mkv).',
  icon: <CloudArrowUp size={22} weight="bold" />,
  requiresControl: true,
  start: async (context: MediaSourceContext) => {
    const file = await chooseFile();
    if (!file) return;

    if (!hasAllowedVideoExtension(file.name)) {
      throw new Error(errorMessage('unsupported_type'));
    }

    const tokenRes = await context.requestUploadToken({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    });
    if (!tokenRes.ok) throw new Error(errorMessage(tokenRes.error));

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', tokenRes.uploadUrl);
      xhr.setRequestHeader('Content-Type', tokenRes.contentType);
      // Sem o progresso, um vídeo grande parece travado: a única pista seria
      // o card em loading, sem nenhuma noção de quanto falta.
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          context.onProgress?.('upload', Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(errorMessage('upload_failed')));
      };
      xhr.onerror = () => reject(new Error(errorMessage('upload_failed')));
      xhr.send(file);
    });

    context.addToPlaylist({ kind: 'file', src: tokenRes.publicUrl, title: titleFromFileName(file.name) });
  },
};
