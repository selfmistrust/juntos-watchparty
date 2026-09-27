'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { DrivePickerPanel } from '@/components/media/DrivePickerPanel';
import { useDriveAccount } from '@/hooks/useDriveAccount';
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
 * O card não "toca do Drive". Ele abre um seletor de arquivos, e o que a pessoa
 * escolhe é **copiado** para o bucket da sala. A fonte nunca vira item de
 * playlist com `kind: 'drive'` — não existe esse `kind`, e não precisa: a faixa
 * entra como `kind: 'file'`, igual a um envio comum, e o player não ganha um
 * modo novo.
 *
 * Isso é o que resolve o problema de fundo de um arquivo privado: se a faixa
 * apontasse para o Drive, só quem escolheu conseguiria tocar. Depois da cópia,
 * todo mundo assiste da mesma URL, sem token e sem permissão de compartilhamento.
 */
export function useDriveSource(): {
  provider: MediaSourceProvider;
  panel: ReactNode;
} {
  const { status, loading, busy, message, error, connect, disconnect } = useDriveAccount();
  const [contexto, setContexto] = useState<MediaSourceContext | null>(null);

  const conta = useMemo<MediaSourceAccount>(
    () => ({
      configured: status.configured,
      connected: status.connected,
      // O Drive não tem "canal": quem identifica a conta é a pessoa, e o nome de
      // exibição do Google serve.
      detail: status.displayName || status.email,
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
        ? 'A integração com o Drive não está configurada no servidor.'
        : conta.connected
          ? 'Copie um vídeo do seu Drive para a fila.'
          : 'Conecte sua conta para copiar um vídeo do Drive.',
      account: conta,
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
    panel: contexto ? <DrivePickerPanel open context={contexto} onClose={fechar} /> : null,
  };
}
