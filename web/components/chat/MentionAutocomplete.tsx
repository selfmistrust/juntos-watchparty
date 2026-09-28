'use client';

import { UserCircle } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import type { User } from '@/types';

interface Props {
  /** Participantes que casam com o que está sendo digitado. */
  sugestoes: User[];
  /** Índice destacado, controlado por quem abre a lista. */
  ativo: number;
  onEscolher: (user: User) => void;
  /** Abre o perfil, sem inserir a menção. */
  onVerPerfil: (user: User) => void;
  /** O mouse passou por cima de um item: só move o destaque, não escolhe. */
  onPassarOMouse: (indice: number) => void;
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
export function MentionAutocomplete({
  sugestoes,
  ativo,
  onEscolher,
  onVerPerfil,
  onPassarOMouse,
}: Props) {
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
          <li
            key={user.sessionId}
            role="option"
            aria-selected={indice === ativo}
            /*
             * O `aria-label` existe porque a linha tem dois botões dentro. Sem
             * ele, um leitor de tela anunciaria o nome, o "mencionar" e o "ver
             * perfil" como três coisas em sequência, e a pessoa não ouviria uma
             * opção de lista — ouviria um menu.
             */
            aria-label={user.name}
          >
            {/*
              * Duas ações por linha, e por isso um `div` em volta: botão dentro
              * de botão é HTML inválido, e o botão de perfil ficaria preso
              * dentro da área de clique do nome — clicar nele inseriria a
              * menção em vez de abrir o perfil.
              *
              * A ordem é nome primeiro, perfil depois, porque inserir é o que se
              * faz quase sempre; perfil é para quando há dois "Maria" e é
              * preciso saber qual.
              *
              * O `onMouseEnter` **muda o índice ativo em vez de inserir**. A
              * primeira versão chamava `onEscolher` no hover, que é o pior
              * defeito possível num autocomplete: passar o mouse sobre a lista
              * escrevia `@Nome Completo` no meio da frase, sem ninguém pedir.
              */}
            <div
              className={`flex items-center gap-1 rounded-lg pr-1 transition-colors ${
                indice === ativo ? 'bg-accent-soft' : ''
              }`}
            >
              <button
                type="button"
                // `onMouseDown` e não `onClick`: o clique no item acontece depois
                // de o `blur` do textarea, e a seleção sumiria junto com o
                // destaque. O `preventDefault` do mousedown é o que segura o foco.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onEscolher(user);
                }}
                onMouseEnter={() => onPassarOMouse(indice)}
                aria-label={`Mencionar ${user.name}`}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-ink-muted transition-colors hover:bg-hover hover:text-ink"
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
              <button
                type="button"
                onMouseDown={(e) => {
                  // Mesmo `preventDefault` do botão ao lado, pelo mesmo motivo:
                  // o `blur` do campo fecharia a lista junto com o `mousedown`.
                  e.preventDefault();
                  onVerPerfil(user);
                }}
                aria-label={`Ver perfil de ${user.name}`}
                title={`Ver perfil de ${user.name}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <UserCircle size={17} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
