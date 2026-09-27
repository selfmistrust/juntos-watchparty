'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { isDesktop } from '@/lib/desktop';
import {
  disconnectDrive,
  driveConnectUrl,
  driveStartUrl,
  fetchDriveStatus,
  type DriveAccountStatus,
} from '@/lib/driveAccount';

const idle: DriveAccountStatus = { configured: false, connected: false };

type DriveAccountValue = {
  status: DriveAccountStatus;
  loading: boolean;
  busy: boolean;
  message: string | null;
  error: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const DriveAccountContext = createContext<DriveAccountValue | null>(null);

/** As mesmas quatro mensagens do YouTube, adaptadas ao que a pessoa fez. */
const MENSAGENS: Record<string, string> = {
  connected: 'Conta do Drive conectada.',
  denied: 'A autorização do Google Drive foi recusada.',
  not_configured: 'A conexão com o Google Drive ainda não está configurada no servidor.',
  error: 'Não foi possível conectar o Google Drive. Tente de novo.',
};

function mensagemDe(estado: string | string[] | undefined): string | null {
  const valor = Array.isArray(estado) ? estado[0] : estado;
  if (!valor) return null;
  return MENSAGENS[valor] ?? null;
}

/**
 * Estado da conta do Google Drive.
 *
 * ## Onde o login acontece, e por quê
 *
 * No app desktop a autorização sai para o navegador do sistema, porque o Google
 * recusa autenticar dentro da janela do Electron. E o `/start` não pode ser
 * buscado pelo navegador: ele não tem o cookie de sessão do app, e o servidor
 * forjaria uma sessão nova — a conta ficaria ligada a ela, e o app continuaria
 * sem conta nenhuma depois de ter autorizado tudo.
 *
 * Por isso o desktop pede a URL em `POST` (que leva o cookie) e entrega só a
 * URL do Google ao navegador. O registro nasce com a sessão do app, que é quem
 * pergunta pelo estado depois.
 *
 * ## A reconsulta no foco
 *
 * A janela do desktop só descobre que a conta conectou quando recebe o foco de
 * novo, e é aí que este `refresh` roda. Sem ele, o app ficaria mostrando "sem
 * conta" até recarregar — e ninguém recarrega, porque para a pessoa o fluxo já
 * acabou.
 */
export function DriveAccountProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<DriveAccountStatus>(idle);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchDriveStatus());
    } catch {
      setStatus(idle);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', aoVoltar);
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      window.removeEventListener('focus', aoVoltar);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [refresh]);

  // No navegador o callback volta para o app com `?drive=connected`, e a aba é a
  // mesma aba: a mensagem aparece aqui. No desktop o callback mostra a tela de
  // conclusão no navegador, e quem atualiza é o `refresh` do foco.
  const query = router.query.drive;

  useEffect(() => {
    if (!router.isReady) return;
    const aviso = mensagemDe(query);
    if (!aviso) return;
    setMessage(aviso);
    if (query === 'connected' || query === 'denied' || query === 'error') void refresh();
    const resto = { ...router.query };
    delete resto.drive;
    void router.replace({ pathname: router.pathname, query: resto }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, router.isReady, query]);

  const connect = useCallback(() => {
    const returnTo = typeof window !== 'undefined' ? window.location.href : '/';
    if (!isDesktop()) {
      window.location.assign(driveConnectUrl(returnTo));
      return;
    }
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const resposta = await driveStartUrl(returnTo, 'pagina');
        if ('error' in resposta) {
          setError(
            resposta.error === 'not_configured'
              ? MENSAGENS.not_configured
              : 'Não foi possível iniciar a conexão com o Google Drive. Tente de novo.',
          );
          return;
        }
        const abriu = await window.juntosDesktop?.openInSystemBrowser(resposta.url);
        if (abriu === false) setError('Não consegui abrir o navegador para o login do Drive.');
      } catch {
        setError('Não foi possível iniciar a conexão com o Google Drive. Tente de novo.');
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectDrive();
      setStatus((prev) => ({ ...prev, connected: false }));
      setMessage('Conta do Google Drive desconectada.');
    } catch {
      setError('Não foi possível desconectar. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo(
    () => ({ status, loading, busy, message, error, connect, disconnect, refresh }),
    [status, loading, busy, message, error, connect, disconnect, refresh],
  );

  return <DriveAccountContext.Provider value={value}>{children}</DriveAccountContext.Provider>;
}

export function useDriveAccount(): DriveAccountValue {
  const ctx = useContext(DriveAccountContext);
  if (!ctx) throw new Error('useDriveAccount precisa do DriveAccountProvider');
  return ctx;
}
