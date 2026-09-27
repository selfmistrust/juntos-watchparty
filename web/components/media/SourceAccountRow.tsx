'use client';

import { useState } from 'react';
import { CheckCircle } from '@phosphor-icons/react';
import { TruncatedText } from '@/components/ui/TruncatedText';
import type { MediaSourceAccount } from '@/lib/mediaSources/types';

/**
 * Status da conta e os botões de conectar/desconectar de uma fonte.
 *
 * ## Por que isto não está no card
 *
 * Estava. A linha ficava *abaixo* do botão do card, e isso quebrava a grade:
 * o YouTube ficava ~47px mais alto que as outras fontes da linha, porque só ele
 * tem login. O card do Dispositivo, que não tem, era esticado até a altura do
 * vizinho e sobrava um buraco no rodapé — o modal inteiro ficava irregular por
 * causa de um botão.
 *
 * O botão de conectar é uma ação, e ação mora onde a pessoa já está. Clicar no
 * card do YouTube abre o painel de busca, e é lá que a conta é gerenciada: o
 * clique que leva à busca é o mesmo que mostra o login. Ninguém precisa voltar
 * ao card para descobrir que precisa conectar.
 *
 * ## O card continua dizendo o estado
 *
 * Tirar a linha do card não pode custar a informação. O `description` do
 * provider do YouTube carrega o estado da conta, em uma frase que cabe nas duas
 * linhas do card. A conta some do card; o fato de estar ou não conectada, não.
 *
 * Não sabe nada da integração: recebe o que a fonte descreveu. Uma integração
 * nova que peça login desenha esta linha no painel dela, e só isso.
 */
export function SourceAccountRow({
  account,
  className,
}: {
  account: MediaSourceAccount;
  className?: string;
}) {
  const [trocando, setTrocando] = useState(false);

  const ocupado = Boolean(account.busy) || trocando;

  return (
    <div
      className={
        className ??
        'rounded-xl border border-hairline bg-raised/60 px-3 py-2'
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {account.connected ? (
            <>
              <CheckCircle weight="fill" size={13} className="shrink-0 text-live" />
              {/* Nome de canal é o texto mais imprevisível do app: pode ter
                  qualquer tamanho e nenhuma regra. Vai numa linha com
                  reticência, e o `title` devolve o nome inteiro. */}
              <TruncatedText
                text={account.detail || 'Conta conectada'}
                className="text-2xs text-ink-muted"
              />
            </>
          ) : (
            /*
             * Este texto quebra em duas linhas em vez de ser cortado: o painel é
             * estreito, e "Nenhuma conta conectada" não cabe ao lado do botão.
             * Cortar mostrava "Nenhuma conta conect…", que é pior que quebrar —
             * o nome do canal, quando existe, é curto e continua em uma linha só.
             */
            <span className="min-w-0 text-2xs leading-snug text-ink-faint">
              {account.configured
                ? 'Nenhuma conta conectada'
                : 'Integração não configurada'}
            </span>
          )}
        </span>

        {account.connected ? (
          <button
            type="button"
            onClick={() => {
              setTrocando(true);
              void account.disconnect().finally(() => setTrocando(false));
            }}
            disabled={ocupado}
            className="min-w-0 shrink-0 whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:px-3"
          >
            {ocupado ? 'Saindo…' : 'Trocar de conta'}
          </button>
        ) : (
          <button
            type="button"
            onClick={account.connect}
            disabled={!account.configured || account.busy}
            className="min-w-0 shrink-0 whitespace-nowrap rounded-md bg-accent px-2 py-1 text-2xs font-medium text-white transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:px-3"
          >
            {account.busy ? 'Conectando…' : 'Conectar'}
          </button>
        )}
      </div>

      {account.error && (
        <p className="animate-fade-up mt-1 text-2xs leading-relaxed text-live/90">{account.error}</p>
      )}
      {account.message && !account.error && (
        <p className="animate-fade-up mt-1 text-2xs leading-relaxed text-ink-faint">{account.message}</p>
      )}
    </div>
  );
}
