import { Check, Link as LinkIcon, LockSimple, SidebarSimple } from '@phosphor-icons/react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import type { RoomSnapshot } from '@/types';

interface Props {
  state: RoomSnapshot;
  connected: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function RoomHeader({ state, connected, sidebarOpen, onToggleSidebar }: Props) {
  const [copied, setCopied] = useState(false);

  const copyInvite = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const visible = state.users.slice(0, 4);
  const overflow = state.users.length - visible.length;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-3 sm:px-4">
      <Link
        href="/"
        className="shrink-0 font-display text-base tracking-tight text-ink transition-colors duration-150 hover:text-accent"
      >
        juntos
      </Link>

      <span className="hidden h-4 w-px bg-hairline sm:block" />

      <div className="flex min-w-0 items-center gap-2">
        <span
          className={clsx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            connected ? 'animate-pulse-ring bg-live' : 'bg-ink-faint',
          )}
        />
        <span className="truncate text-sm text-ink-muted">
          {connected ? state.name : 'Reconectando…'}
        </span>
        <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
          {state.id}
        </span>
        {state.hasPassword && (
          <LockSimple size={13} weight="fill" className="shrink-0 text-ink-faint" aria-label="Sala protegida por senha" />
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="hidden items-center sm:flex">
          {visible.map((user, i) => (
            <span key={user.sessionId} className={clsx(i > 0 && '-ml-2')}>
              <Avatar
                name={user.name}
                color={user.color}
                avatarSeed={user.avatarSeed}
                avatarUrl={user.avatarUrl}
                size="sm"
                className="ring-2 ring-canvas"
              />
            </span>
          ))}
          {overflow > 0 && (
            <span className="-ml-2 flex h-6 items-center rounded-full bg-raised px-2 text-2xs text-ink-muted ring-2 ring-canvas">
              +{overflow}
            </span>
          )}
        </div>

        <button
          onClick={copyInvite}
          className="flex h-9 items-center gap-2 rounded-xl border border-hairline bg-raised px-3 text-sm text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink"
        >
          {copied ? <Check size={15} weight="bold" className="text-accent" /> : <LinkIcon size={15} />}
          <span className="hidden sm:inline">{copied ? 'Link copiado' : 'Convidar'}</span>
        </button>

        <IconButton
          label={sidebarOpen ? 'Ocultar painel' : 'Mostrar painel'}
          onClick={onToggleSidebar}
          active={sidebarOpen}
        >
          <SidebarSimple size={18} />
        </IconButton>
      </div>
    </header>
  );
}
