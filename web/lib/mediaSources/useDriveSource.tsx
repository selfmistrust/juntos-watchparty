'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { DrivePickerPanel } from '@/components/media/DrivePickerPanel';
import { useDriveAccount } from '@/hooks/useDriveAccount';
import { drivePickerConfigured } from '@/lib/driveAccount';
import { isDesktop } from '@/lib/desktop';
import { driveProvider } from './drive';
import type { MediaSourceAccount, MediaSourceContext, MediaSourceProvider, MediaSourceState } from './types';
import { READY, checking } from './types';

/**
 * Provider do Google Drive, com o seletor de arquivos acoplado.
 *
 * ## Onde a conta é gerenciada
 *
 * A linha de conta do YouTube ficou no painel, e o Drive segue o mesmo caminho —
 * pelo motivo já registrado: uma linha a mais no card desalinha a grade, e só o
 * YouTube teria uma.
 *
 * ## O que a fonte realmente faz
 *
 * O card não "toca do Drive" e também não copia nada. O que a pessoa escolhe no
 * Picker entra na fila como `kind: 'file'`, com o `src` apontando para a rota de
 * stream do servidor, e o `<video>` pede os bytes por partes. Não existe um
 * `kind` novo, e o player não ganha um modo novo.
 *
 * ## O preço disso
 *
 * O token do Drive é de quem escolheu, e é ele que serve o stream para a sala
 * toda. Se essa pessoa desconectar, a faixa para. Em troca, ninguém espera o
 * arquivo baixar: a reprodução começa no primeiro bloco que chega, e.seek
 * funciona.
 */
export function useDriveSource(): {
  provider: MediaSourceProvider;
  panel: ReactNode;
} {
  const { status, loading, busy, message, error, connect, disconnect, refresh } = useDriveAccount();
  const [contexto, setContexto] = useState<MediaSourceContext | null>(null);

  const conta = useMemo<MediaSourceAccount>(
    () => ({
      configured: status.configured && (isDesktop() || drivePickerConfigured()),
      connected: status.connected,
      busy,
      message,
      error,
      connect,
      disconnect,
    }),
    [status, busy, message, error, connect, disconnect],
  );

  const abrir = useCallback((ctx: MediaSourceContext) => setContexto(ctx), []);
  const fechar = useCallback(() => setContexto(null), []);

  /*
   * O provider é memoizado pelo mesmo motivo do YouTube: a lista de fontes do
   * modal depende dele, e uma identidade nova a cada render faria o modal
   * reconsultar o estado sem parar.
   */
  const provider = useMemo<MediaSourceProvider>(
    () => ({
      ...driveProvider,
      // A descrição sai de `conta`, e não de `status`: `conta` já está nas
      // dependências e traz os mesmos dois campos, então descrever por ela
      // evita a lista de dependências divergir do que o memo realmente lê.
      description: !conta.configured
        ? 'O Google Drive ainda não está configurado para este app.'
        : conta.connected
          ? 'Escolha um vídeo no Picker e a sala assiste na hora.'
          : 'Conecte sua conta para escolher um vídeo do Drive.',
      /*
       * Nunca fica realmente indisponível. Sem conta, abrir o seletor mostra o
       * botão de conectar dentro dele; o problema é "não tenho conta", não
       * "não dá para usar".
       */
      resolveState: async (): Promise<MediaSourceState> => (loading ? checking() : READY),
      start: async (context) => {
        abrir(context);
      },
    }),
    [conta, loading, abrir],
  );

  return {
    provider,
    panel: contexto ? <DrivePickerPanel open context={contexto} account={conta} refreshAccount={refresh} onClose={fechar} /> : null,
  };
}
