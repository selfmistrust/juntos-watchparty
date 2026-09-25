'use client';

import { X, ArrowArcLeft } from '@phosphor-icons/react';
import type { ChatMessage } from '@/types';

interface Props {
  /** Mensagem que está sendo respondida. */
  message: ChatMessage;
  /** Callback para cancelar a resposta. */
  onCancel: () => void;
  /** Nome do usuário atual (para exibir "Você"). */
  currentUserName?: string;
}

export function ReplyPreview({ message, onCancel, currentUserName }: Props) {
  const previewText = message.kind === 'text'
    ? message.text
    : message.kind === 'gif'
      ? `[GIF] ${message.text || message.mediaUrl || ''}`
      : message.kind === 'image'
        ? '[Imagem]'
        : '';

  const displayName = message.userId === currentUserName ? 'Você' : message.name;

  return (
    <div className="relative mb-2 rounded-lg bg-accent-soft/30 border border-accent/30 p-2.5 animate-fade-up">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-accent">
          <ArrowArcLeft size={12} weight="fill" />
          <span>Respondendo a <strong>{displayName}</strong></span>
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-hover transition-colors"
          aria-label="Cancelar resposta"
        >
          <X size={14} />
        </button>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm text-ink/80 whitespace-pre-wrap break-words">
        {previewText}
      </p>
    </div>
  );
}