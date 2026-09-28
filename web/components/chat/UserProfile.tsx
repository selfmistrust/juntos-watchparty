'use client';

import { useEffect } from 'react';
import { X } from '@phosphor-icons/react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
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
 *
 * ## Um botão de fechar só, e é o X
 *
 * Havia um `Fechar` largo embaixo e um `X` no canto, e os dois chamavam a mesma
 * coisa. O botão embaixo foi removido.
 *
 * A razão não é só "os dois são iguais". O cartão **não tem nenhuma outra
 * ação**: ele não menciona, não copia link, não muda nada. Um botão de largura
 * inteira é o elemento mais pesado do cartão, e ele está anunciando uma
 * decisão que o cartão não oferece — a pessoa lê "Fechar" no rodapé e conclui
 * que tem algo a fazer ali. Além disso ele empurrava o cartão para baixo sem
 * acrescentar nada.
 *
 * O X é onde o olho já está: canto superior direito de um overlay é a convenção
 * que toda pessoa espera, e é o mesmo `X` que o resto do app usa.
 *
 * Fechar continua disponível por três caminhos além do X: `Escape`, o clique no
 * fundo, e o toque em qualquer lugar do cartão. O botão não era o único jeito,
 * era só o mais visível — e visível demais para uma ação sem nada atrás.
 *
 * E sem o botão largo, o X deixa de ser um dos dois e vira o alvo de toque, o
 * que devolve o `dense` para 44px.
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
          {/*
           * Sem `dense`: o `dense` existe para fileiras de botões na largura toda
           * do celular, onde quatro alvos de 44px comem a largura e sobram pouco
           * para o campo de texto ao lado. Aqui não há fileira nenhuma — o cartão
           * é um overlay com um botão só, e ficar sem o botão largo significa
           * que o X passa a ser o alvo de toque. Ele tem que ser o alvo de
           * verdade: 44px, que é o padrão do resto do app.
           */}
          <IconButton label="Fechar" onClick={onFechar}>
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
      </div>
    </div>
  );
}
