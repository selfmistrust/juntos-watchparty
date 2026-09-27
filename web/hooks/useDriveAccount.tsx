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

  /*
   * `message` é um **evento** — "acabei de conectar" — e `status.connected` é
   * um **estado**. Misturar os dois produz a tela da captura: a linha de status
   * dizia "Nenhuma conta conectada" e, logo abaixo, "Conta do Drive conectada",
   * porque a mensagem do OAuth continuava na tela depois que o estado já era o
   * oposto.
   *
   * A divergência tem um caminho silencioso: `refresh` roda a cada foco de
   * janela, e ele atualiza o estado sem tocar na mensagem. Quem saía do OAuth
   * vê a confirmação — e, se depois algo desconectasse a conta por outro caminho
   * (a aba do Google, o `token_unavailable` do servidor), a confirmação ficaria
   * lá para sempre, ao lado de um status que a contradiz.
   *
   * A regra aqui é estreita e é a que resolve: **o que o estado diz agora
   * vence**. A mensagem de sucesso é de consulta única — aparece no retorno do
   * OAuth e sai assim que o estado confirma. Uma mensagem de erro, essa sim,
   * persiste, porque não é contrariada por um estado que voltou a ser bom.
   */
  const refresh = useCallback(async () => {
    try {
      const novo = await fetchDriveStatus();
      setStatus(novo);
      if (novo.connected) {
        setMessage((atual) => (atual && atual.startsWith('Conta do Drive conectada') ? null : atual));
      } else {
        // Conectado e depois desconectado sem passar por aqui: o estado manda,
        // e a confirmação antiga é information falsa.
        setMessage((atual) => (atual === 'Conta do Drive conectada.' ? null : atual));
      }
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
    /*
     * A confirmação é mostrada **antes** do `refresh` terminar, para não haver um
     * instante em que a tela não diz nada. O `refresh` decide se ela fica: se o
     * servidor responder que a conta não está conectada, o aviso de sucesso é
     * information falsa e sai junto.
     */
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
