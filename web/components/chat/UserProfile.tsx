'use client';

import { useEffect } from 'react';
import { X } from '@phosphor-icons/react';
import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { formatClock } from '@/lib/media';
import type { User } from '@/types';

interface Props {
  user: User;
  /** `true` quando o perfil aberto é o da própria pessoa. */
  isMe: boolean;
  isHost: boolean;
  onFechar: () => void;
}

/**
 * Perfil de quem foi mencionado.
 *
 * ## Por que um modal e não um card no chat
 *
 * A menção fica dentro da mensagem, e a mensagem rola. Abrir um painel ao lado
 * empurraria o feed e a pessoa perderia de vista **onde** a menção estava — que
 * é o contexto que fez ela clicar. Modal mantém a mensagem visível atrás.
 *
 * ## O que ele mostra
 *
 * Só o que já é público na sala: nome, avatar, desde quando está presente, e o
 * papel (host/DJ). Nada de dado que a sala não mostra — o perfil não vira uma
 * ficha de onde a pessoa não está.
 */
export function UserProfile({ user, isMe, isHost, onFechar }: Props) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onFechar]);

  const desde = user.lastSeen ? new Date(user.lastSeen) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Só fecha no clique no fundo. Um `onClick` no container fecharia também
        // ao clicar no cartão, que é o que se quer evitar.
        if (e.target === e.currentTarget) onFechar();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Perfil de ${user.name}`}
        className="animate-fade-up w-full max-w-xs rounded-2xl border border-hairline bg-surface p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <Avatar
            name={user.name}
            color={user.color}
            avatarSeed={user.avatarSeed}
            avatarUrl={user.avatarUrl}
            size="lg"
          />
          <IconButton dense label="Fechar" onClick={onFechar}>
            <X size={15} />
          </IconButton>
        </div>

        <p className="mt-3 break-words text-base font-medium text-ink">{user.name}</p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {isMe && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-accent">
              Você
            </span>
          )}
          {isHost && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-accent">
              Host
            </span>
          )}
          {!user.connected && (
            <span className="rounded-full bg-raised px-2 py-0.5 text-2xs text-ink-faint">
              Desconectado
            </span>
          )}
        </div>

        {desde && user.connected && (
          <p className="mt-3 text-2xs text-ink-faint">
            Na sala desde {formatClock(desde.getTime())}
          </p>
        )}

        <div className="mt-4">
          <Button onClick={onFechar} className="w-full" variant="outline">
            Fechar
          </Button>
        </div>
      </div>
    </div>
  );
}
