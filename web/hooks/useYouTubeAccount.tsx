import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import {
  disconnectYoutube,
  fetchYoutubeStatus,
  youtubeConnectUrl,
  youtubeOauthMessage,
  type YoutubeAccountStatus,
} from '@/lib/youtubeAccount';

const idle: YoutubeAccountStatus = { configured: false, connected: false };

type YoutubeAccountContextValue = {
  status: YoutubeAccountStatus;
  loading: boolean;
  busy: boolean;
  message: string | null;
  error: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const YoutubeAccountContext = createContext<YoutubeAccountContextValue | null>(null);

export function YoutubeAccountProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<YoutubeAccountStatus>(idle);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchYoutubeStatus();
      setStatus(next);
    } catch {
      setStatus(idle);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * Reconsulta quando a janela volta a ficar em foco.
   *
   * No app desktop a autorização sai para o navegador do sistema: a pessoa
   * autoriza lá, a janela do app perde o foco, e o callback do servidor
   * acontece fora dela. Sem esta reconsulta, o app continuaria mostrando
   * "sem conta" até recarregar — que é o que a pessoa não vai fazer, porque
   * para ela o fluxo já acabou.
   *
   * `visibilitychange` cobre o mesmo caso no navegador, em aba de fundo. Os dois
   * escutam juntos porque alternam entre si conforme o sistema decide o que
   * focar, e a reconsulta é barata: um GET de status, sem escrita.
   */
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

  const youtubeQuery = router.query.youtube;

  useEffect(() => {
    if (!router.isReady) return;
    const flash = youtubeOauthMessage(youtubeQuery);
    if (!flash) return;
    setMessage(flash);
    if (youtubeQuery === 'connected' || youtubeQuery === 'denied' || youtubeQuery === 'error') {
      void refresh();
    }
    const query = { ...router.query };
    delete query.youtube;
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, router.isReady, youtubeQuery]);

  const connect = useCallback(() => {
    const returnTo = typeof window !== 'undefined' ? window.location.href : '/';
    window.location.assign(youtubeConnectUrl(returnTo));
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectYoutube();
      setStatus((prev) => ({ ...prev, connected: false, channelTitle: undefined, channelId: undefined }));
      setMessage('Conta do YouTube desconectada.');
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

  return <YoutubeAccountContext.Provider value={value}>{children}</YoutubeAccountContext.Provider>;
}

export function useYouTubeAccount(): YoutubeAccountContextValue {
  const ctx = useContext(YoutubeAccountContext);
  if (!ctx) {
    throw new Error('useYouTubeAccount precisa do YoutubeAccountProvider');
  }
  return ctx;
}
