import { Check, Link as LinkIcon, LockSimple, SidebarSimple, Warning } from '@phosphor-icons/react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { MentionPreferences } from '@/components/chat/MentionPreferences';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { copiarTexto, isDesktop } from '@/lib/desktop';
import type { PreferenciasMencao } from '@/lib/mentionPreferences';
import { SITE_URL } from '@/lib/site';
import type { RoomSnapshot } from '@/types';

interface Props {
  state: RoomSnapshot;
  connected: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /**
   * Preferências de menção, que moravam no cabeçalho do chat.
   *
   * O botão está aqui, e não no painel, por dois motivos. O primeiro é que as
   * três preferências valem para a sala inteira — inclusive com o painel fechado,
   * e era justamente com o painel fechado que "não me perturbe" importava. O
   * segundo é descoberta: no cabeçalho do chat o sino aparecia só depois de
   * abrir o painel, ou seja, nunca na hora em que a pessoa decide se quer
   * interromper.
   */
  mentionPrefs?: PreferenciasMencao;
  onMentionPrefs?: (patch: Partial<PreferenciasMencao>) => void;
  aoPedirPermissaoNotificacao?: () => void;
  jaPediuPermissaoNotificacao?: boolean;
  pushDeMencaoAtivo?: boolean;
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

export function RoomHeader({
  state,
  connected,
  sidebarOpen,
  onToggleSidebar,
  mentionPrefs,
  onMentionPrefs,
  aoPedirPermissaoNotificacao,
  jaPediuPermissaoNotificacao,
  pushDeMencaoAtivo,
}: Props) {
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

        {/*
         * O sino fica aqui, e o `z-30` no wrapper é o que garante isto.
         *
         * O popover abre para baixo, por padrão, a partir de um botão na barra de
         * 56px — e desce por cima do palco. O palco usa `z-10`/`z-20` e o painel
         * lateral não usa z nenhum, então um `z-30` no wrapper coloca o popover
         * acima dos dois. A barra em si não precisa de `relative`: o popover é
         * posicionado pelo `relative` que já existe dentro do `MentionPreferences`.
         */}
        {(mentionPrefs && onMentionPrefs) && (
          <div className="z-30 flex shrink-0 items-center">
            <MentionPreferences
              prefs={mentionPrefs}
              jaPediu={Boolean(jaPediuPermissaoNotificacao)}
              onMudar={onMentionPrefs}
              aoPedirPermissao={aoPedirPermissaoNotificacao ?? (() => undefined)}
              pushAtivo={Boolean(pushDeMencaoAtivo)}
            />
          </div>
        )}

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
