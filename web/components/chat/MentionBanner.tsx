'use client';

import { useEffect, useRef } from 'react';
import { At } from '@phosphor-icons/react';

interface Props {
  /** Quem mencionou, e o que foi dito. */
  fromName: string;
  texto: string;
  preview: string;
  /** Quantas menções se acumularam — mais de uma mostra "e mais N". */
  total: number;
  onAbrir: () => void;
  onFechar: () => void;
}

/**
 * Aviso de menção **dentro do app**.
 *
 * ## Por que esta camada existe, sendo que já há notificação do sistema
 *
 * Porque a notificação do sistema é a camada de que menos se pode depender. O
 * navegador pode tê-la bloqueada, o sistema pode agrupá-la, o usuário pode ter
 * as notificações do site silenciadas, e em vários sistemas ela aparece no canto
 * da tela — longe da janela que a pessoa está olhando, que é onde a menção
 * aconteceu.
 *
 * Relato real: a notificação aparecia como um aviso pequeno no topo, com o
 * título da aba em vez de "fulano te mencionou", e nenhuma pista de onde clicar.
 * Enquanto isso, a informação que a pessoa precisava — *quem me chamou* — não
 * estava em lugar nenhum dentro do app.
 *
 * Então: o aviso é a camada confiável, e a notificação é a que alcança quem está
 * em outro programa. Nenhuma das duas torna a outra redundante.
 *
 * ## Onde fica
 *
 * Acima da barra de bate-papo, dentro da coluna do chat, e não no centro da
 * tela. A menção é sobre o chat, e um aviso no centro da tela taparia o vídeo
 * — que é a única coisa que a pessoa está querendo ver.
 *
 * ## Por que some sozinho
 *
 * Mesmo com o cooldown do servidor, quem foi mencionado pode receber várias. Um
 * aviso fixo acumularia painel sobre painel; e um aviso que precisa ser
 * dispensado à mão vira trabalho. Ele some em 7s, e o contador no título da aba
 * guarda o que não coube.
 */
export function MentionBanner({ fromName, texto, preview, total, onAbrir, onFechar }: Props) {
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // O timer reinicia a cada menção: chegar uma segunda menção enquanto o aviso
    // está no ar deve estender o prazo, não deixar o primeiro sumir por baixo da
    // segunda.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onFechar, 7000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fromName, texto, onFechar]);

  return (
    <div
      /*
       * `bottom` acompanha a barra do chat, que é `absolute bottom-0`. Ficar
       * logo acima dela é o que faz o aviso parecer parte do chat em vez de
       * algo flutuando no meio do app.
       */
      className="animate-fade-up absolute inset-x-3 bottom-24 z-40 lg:bottom-28"
      role="status"
      aria-live="polite"
    >
      {/*
        * `bg-raised`, e nao `bg-popover`: o tema define `canvas`, `surface`,
        * `raised`, `hover`, `hairline`, `ink`, `accent` e `live` -- e nao tem
        * `popover`. Uma classe de cor que o tema nao define nao gera CSS nenhum,
        * sem aviso: o `background-color` simplesmente volta como transparente.
        * Era esse o fundo do aviso, que e a camada de que mais se depende, porque
        * a notificacao do sistema e a menos confiavel das duas.
        *
        * E opaco de proposito: translucidez aqui deixaria as mensagens de tras
        * aparecerem por dentro do texto do aviso.
        */}
      <div className="flex items-start gap-2 rounded-xl border border-accent/40 bg-raised p-2.5 shadow-lg">
        <At size={18} weight="bold" className="mt-0.5 shrink-0 text-accent" />
        <button
          type="button"
          onClick={onAbrir}
          className="min-w-0 flex-1 text-left"
          title="Abrir o bate-papo"
        >
          <p className="truncate text-xs font-medium text-ink">
            <span className="text-accent">{fromName}</span> te mencionou
            {total > 1 && <span className="text-ink-faint"> · mais {total - 1}</span>}
          </p>
          {/*
            * O `@` entra separado do nome para o destino ficar clicável e o
            * nome também, e os dois precisam estar dentro do mesmo botão — dois
            * alvos de 8px numa faixa de aviso não é alvo de dedo.
            */}
          <p className="truncate text-2xs text-ink-muted">
            @{texto} · {preview}
          </p>
        </button>
        <button
          type="button"
          onClick={onFechar}
          aria-label="Dispensar aviso de menção"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          Dispensar
        </button>
      </div>
    </div>
  );
}
