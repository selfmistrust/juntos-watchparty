import { Check, Link as LinkIcon, LockSimple, SidebarSimple, Warning } from '@phosphor-icons/react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { copiarTexto, isDesktop } from '@/lib/desktop';
import { SITE_URL } from '@/lib/site';
import type { RoomSnapshot } from '@/types';

interface Props {
  state: RoomSnapshot;
  connected: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

/**
 * O link que a pessoa manda para o amigo.
 *
 * No navegador é a URL em que ela está. No app desktop **não pode ser**: a
 * janela roda em `http://localhost:3210`, que só existe na máquina de quem
 * está com o app aberto. Copiar isso produz um link que não abre para ninguém —
 * o botão funcionava e o convite não valia nada.
 *
 * O desktop troca a origem pelo site público e mantém o caminho, que é o mesmo
 * em ambos. `SITE_URL` vem de `NEXT_PUBLIC_SITE_URL` e, se não estiver
 * definida, o código cai na URL atual: no navegador isso é exatamente o
 * comportamento de sempre, e no desktop é um link localhost — defeituoso, mas
 * visível, em vez de silenciosamente errado.
 */
function linkDeConvite(): string {
  if (!isDesktop()) return window.location.href;
  const caminho = `${window.location.pathname}${window.location.search}`;
  return `${SITE_URL}${caminho}`;
}

export function RoomHeader({ state, connected, sidebarOpen, onToggleSidebar }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copyInvite = async () => {
    const ok = await copiarTexto(linkDeConvite());
    // Só o sucesso troca o rótulo. Um "Link copiado" sobre um link que não foi
    // copiado é pior do que avisar que não deu.
    setCopied(ok);
    setCopyFailed(!ok);
    setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 1800);
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
        {/* Nome de sala é texto livre: qualquer tamanho, nenhuma regra. Vai
            cortado em uma linha, e o `title` devolve o nome inteiro. */}
        <TruncatedText
          text={connected ? state.name : 'Reconectando…'}
          className="text-sm text-ink-muted"
        />
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
          className="flex h-9 min-w-0 items-center gap-2 whitespace-nowrap rounded-xl border border-hairline bg-raised px-3 text-sm text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:px-0"
        >
          {copied ? (
            <Check size={15} weight="bold" className="text-accent" />
          ) : copyFailed ? (
            <Warning size={15} weight="bold" className="text-live" />
          ) : (
            <LinkIcon size={15} />
          )}
          <span className="hidden sm:inline">
            {copied ? 'Link copiado' : copyFailed ? 'Não consegui copiar' : 'Convidar'}
          </span>
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
