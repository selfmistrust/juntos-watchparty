'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import type { User } from '@/types';

interface Props {
  /** Participantes que casam com o que está sendo digitado. */
  sugestoes: User[];
  /** Índice destacado, controlado por quem abre a lista. */
  ativo: number;
  onEscolher: (user: User) => void;
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Autocomplete de menções.
 *
 * ## A posição
 *
 * Fica **acima** do campo, e não colado nele. A lista tem até seis itens de
 * 40px, e o campo de mensagem é o único espaço de que a pessoa precisa em
 * qualquer momento. Abaixo, a lista empurraria o campo para cima e a sala
 * rolaria junto — que é o defeito mais comum de autocomplete em chat, e o
 * motivo de esta lista ser `bottom-full` por padrão, e não `top-full`.
 *
 * ## Um item por altura
 *
 * Alto o suficiente para o dedo (`min-h-10`), e só isso. Cada item é uma linha
 * com avatar e nome; a coluna de "quem é" fica no texto, e a lista não tenta
 * ser um painel de perfil.
 *
 * ## Sem `aria-activedescendant` aqui
 *
 * O papel de combobox fica no `textarea`, que é quem tem o foco e de onde sai o
 * valor aceito. Esta lista é um `listbox` simples, referenciado por
 * `aria-controls` do campo — o que evita oactic duplicar estado de foco entre os
 * dois elementos e ter dois "ativo" divergindo.
 */
export function MentionAutocomplete({ sugestoes, ativo, onEscolher }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [virado, setVirado] = useState(false);

  /*
   * Abre para cima até não sair do painel, e para baixo se ainda couber.
   *
   * Medir depois do desenho é o que evita o flash: com a lista já posicionada
   * no DOM, o `getBoundingClientRect` dá o tamanho real, e a virada acontece
   * antes do navegador pintar.
   */
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const alvo = el.parentElement;
    if (!alvo) return;
    const espaco = alvo.getBoundingClientRect();
    const caixa = el.getBoundingClientRect();
    setVirado(caixa.top < espaco.top);
  }, [sugestoes.length]);

  if (sugestoes.length === 0) return null;

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Participantes para mencionar"
      className={`absolute inset-x-0 z-30 overflow-hidden rounded-xl border border-hairline bg-popover/95 shadow-lg backdrop-blur-md ${
        virado ? 'bottom-full mb-2' : 'top-full mt-2'
      }`}
    >
      {/*
        * Altura limitada: com muita gente na sala, a lista não pode cobrir o
        * vídeo inteiro. Seis itens e rolagem é o ponto onde a pessoa ainda
        * reconhece o nome sem ler.
        */}
      <ul className="scroll-thin max-h-60 overflow-y-auto p-1">
        {sugestoes.map((user, indice) => (
          <li key={user.sessionId} role="option" aria-selected={indice === ativo}>
            <button
              type="button"
              // `onMouseDown` e não `onClick`: o clique no item acontece depois
              // de o `blur` do textarea, e a seleção sumiria junto com o
              // destaque. O `preventDefault` do mousedown é o que segura o foco.
              onMouseDown={(e) => {
                e.preventDefault();
                onEscolher(user);
              }}
              onMouseEnter={() => onEscolher(user)}
              className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                indice === ativo ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-hover'
              }`}
            >
              <Avatar
                name={user.name}
                color={user.color}
                avatarSeed={user.avatarSeed}
                avatarUrl={user.avatarUrl}
                size="sm"
              />
              <span className="min-w-0 truncate text-sm">{user.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
