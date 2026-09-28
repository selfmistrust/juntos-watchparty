'use client';

import { UserCircle } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { normalizar } from '@/lib/mentionHighlight';
import type { User } from '@/types';

interface Props {
  /** Participantes que casam com o que está sendo digitado. */
  sugestoes: User[];
  /** O que a pessoa digitou depois do `@`, para destacar na lista. */
  consulta: string;
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
 * Divide o nome do participante no que casou com o que foi digitado, e pinta a
 * parte que casou.
 *
 * ## É aqui que o roxo da menção em curso vive
 *
 * O destaque de `@Beni` enquanto a pessoa digita **não pode ficar no campo**. Um
 * `textarea` não sabe colorir parte do próprio texto, e a saída conhecida — o
 * espelho, desenhando o mesmo texto por trás do campo com o de cima
 * transparente — resolve isso tirando o campo de verdade do caminho. O
 * resultado foi um campo com caret invisível, digitação estranha e seleção
 * instável.
 *
 * Aqui o mesmo destaque não custa nada, porque um item de lista é um elemento
 * normal: cor, peso e recorte funcionam, e o campo fica intocado.
 *
 * ## Por que a comparação é normalizada, e o corte é no texto original
 *
 * A pessoa digita `@joao` e o nome é `João`. A comparação passa pela forma
 * normalizada, mas o **corte** é feito sobre o nome como está — e é por isso que
 * o resultado mostra "João" e não "joao".
 *
 * O `@` fica de fora do roxo: é o que a pessoa já digitou antes de qualquer
 * nome, e pintá-lo junto faria o `@` parecer parte do nome de alguém.
 */
function dividir(nome: string, consulta: string) {
  const alvo = normalizar(consulta);
  if (!alvo) return <>{nome}</>;

  /*
   * O tamanho do corte é medido no nome normalizado, e o corte é aplicado no
   * original. Para nome em português os dois coincidem, porque `NFD` seguido da
   * remoção de marcas devolve o caractere com o mesmo comprimento — mas isso não
   * é garantido para toda entrada, e é por isso que o índice é limitado ao
   * tamanho do nome. Índice fora do alcance faria `slice` devolver vazio, e o
   * nome desapareceria da lista em vez de aparecer inteiro.
   */
  const tamanho = Math.min(normalizar(nome).indexOf(alvo) + alvo.length, nome.length);
  const casou = nome.slice(0, tamanho);
  const resto = nome.slice(tamanho);

  return (
    <>
      <span className="text-accent">@{casou}</span>
      {resto}
    </>
  );
}

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
  consulta,
  ativo,
  onEscolher,
  onVerPerfil,
  onPassarOMouse,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /*
   * `virado` significa "a lista esta abaixo do campo". O padrao e **acima**, e o
   * efeito so vira para baixo quando ela nao couber em cima.
   */
  const [virado, setVirado] = useState(false);

  /*
   * ## O padrao estava do lado errado, e a lista saia da tela
   *
   * Medido em 27/09, na sala publicada, com uma pessoa na lista:
   *
   * - janela: 1296 x 886
   * - a barra de digitar: `top` 818, `bottom` 874
   * - a lista, desenhada com `top-full` (abaixo): `top` 882, `bottom` 932
   *
   * A janela acaba em 886. A lista terminava em 932: quase toda fora da tela, com
   * 4px aparecendo. Abaixo do campo havia 12px; acima, 818px. A lista cabia em
   * cima com folga e nao cabia embaixo em hipotese alguma -- e mesmo assim era
   * desenhada embaixo.
   *
   * A comparacao `top < 0` estava certa e media na configuracao errada. Com o
   * padrao em `top-full` a lista e desenhada embaixo, da `top` 882: nunca
   * negativa, nunca zero, e a condicao nunca disparava. Ela ficava embaixo para
   * sempre.
   *
   * ## Por que o padrao e acima
   *
   * O campo de mensagem fica no rodape do painel. Acima dele existe a area de
   * mensagens, alta e rolavel; abaixo existe so a margem da pagina. A lista cabe
   * em cima em quase toda situacao, entao "acima" e o estado que funciona sem
   * depender de medicao -- e a medicao so e necessaria para o caso raro, que e a
   * lista com gente demais para caber na area de mensagens.
   *
   * Com o padrao em cima, `top < 0` volta a ser a pergunta certa: a lista subiu
   * para fora do topo da janela? Se sim, ela nao coube em cima, e o unico lugar
   * que sobra e embaixo.
   *
   * ## Por que medir depois do desenho
   *
   * Com a lista ja no DOM e posicionada, o `getBoundingClientRect` da tamanho e
   * posicao reais. Medir antes exigiria adivinhar a altura, e a decisão viria
   * errada justamente quando a lista e mais alta do que o previsto.
   */
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setVirado(el.getBoundingClientRect().top < 0);
  }, [sugestoes.length]);

  if (sugestoes.length === 0) return null;

  return (
    /*
     * `bg-raised` e nao `bg-popover`: o tema define `canvas`, `surface`,
     * `raised`, `hover`, `hairline`, `ink`, `accent` e `live` -- e nao tem
     * `popover`. Cor fora do tema nao da erro, nao gera CSS e nao avisa: o
     * `background-color` volta como transparente e a lista aparece com borda,
     * texto e avatar flutuando sobre as mensagens. Medido em 27/09 na sala
     * publicada: `rgba(0, 0, 0, 0)`.
     *
     * Opaco de proposito. Com `/95` as mensagens de tras apareceriam por dentro
     * do nome de quem esta sendo sugerido.
     */
    <div
      ref={ref}
      role="listbox"
      aria-label="Participantes para mencionar"
      className={`absolute inset-x-0 z-30 overflow-hidden rounded-xl border border-hairline bg-raised shadow-lg ${virado ? 'top-full mt-2' : 'bottom-full mb-2'}`}
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
                <span className="min-w-0 truncate text-sm">
                  {dividir(user.name, consulta)}
                </span>
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
