import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isDesktop } from '@/lib/desktop';
import {
  disconnectSpotify,
  fetchSpotifyStatus,
  spotifyStartUrl,
  spotifyReproduzAqui,
  type SpotifyStatus,
} from '@/lib/spotifyAccount';

const idle: SpotifyStatus = { configured: false, connected: false };

export type SpotifyPlaybackSupport = 'desconhecido' | 'ok' | 'indisponivel';

type SpotifyAccountValue = {
  status: SpotifyStatus;
  loading: boolean;
  busy: boolean;
  message: string | null;
  error: string | null;
  /** Se o áudio pode tocar **neste** navegador. A busca funciona de qualquer jeito. */
  reproduz: SpotifyPlaybackSupport;
  connect: () => void;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const SpotifyAccountContext = createContext<SpotifyAccountValue | null>(null);

export function SpotifyAccountProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SpotifyStatus>(idle);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reproduz, setReproduz] = useState<SpotifyPlaybackSupport>('desconhecido');

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchSpotifyStatus());
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
   * No desktop a autorização sai para o navegador do sistema e o callback
   * acontece fora da janela do app. Sem isto, o app continuaria dizendo "sem
   * conta" mesmo depois de a pessoa ter conectado — que é o que ela não vai
   * refazer, porque para ela o fluxo já acabou.
   *
   * O callback do Spotify volta para a mesma URL, sem marcador de query, então
   * não há o que ler da query como há no YouTube: a janela que ganhou o foco é
   * o sinal de que algo mudou.
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

  /*
   * A reprodução é checada com o script do SDK, e não por User-Agent.
   *
   * `isDesktop()` é o caso conhecido e é o que decide aqui, porque o Electron é
   * o ambiente onde o player do Spotify é recusado de forma previsível. O
   * `isSecureContext` e a presença de `window.Spotify` são confirmados em
   * `spotifyReproduzAqui`, na hora em que o player é montado.
   */
  useEffect(() => {
    if (isDesktop()) {
      setReproduz('indisponivel');
      return;
    }
    setReproduz(window.isSecureContext ? 'ok' : 'indisponivel');
  }, []);

  const connect = useCallback(() => {
    const returnTo = typeof window !== 'undefined' ? window.location.href : '/';
    const desktop = isDesktop();

    /*
     * Navegador: seguir o `/start` na mesma aba leva o cookie junto e o callback
     * volta para o app.
     *
     * Desktop: o mesmo caminho do YouTube e pelo mesmo motivo. O navegador do
     * sistema não tem o cookie de sessão, então navegar para o `/start` de lá
     * criaria uma sessão nova — a conta ficaria ligada a ela, e o app continuaria
     * sem conta nenhuma. Por isso o desktop pede a URL por `POST`, que leva o
     * cookie, e entrega só a URL ao navegador.
     */
    if (!desktop) {
      window.location.assign('/api/spotify/oauth/start');
      return;
    }

    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const resposta = await spotifyStartUrl(returnTo);
        if ('error' in resposta) {
          setError(
            resposta.error === 'not_configured'
              ? 'A conexão com o Spotify ainda não está configurada no servidor.'
              : 'Não foi possível iniciar a conexão com o Spotify. Tente de novo.',
          );
          return;
        }
        const abriu = await window.juntosDesktop?.openInSystemBrowser(resposta.url);
        if (abriu === false) setError('Não consegui abrir o navegador para o login do Spotify.');
      } catch {
        setError('Não foi possível iniciar a conexão com o Spotify. Tente de novo.');
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectSpotify();
      setStatus((prev) => ({ ...prev, connected: false, displayName: null, email: null, product: null }));
      setMessage('Conta do Spotify desconectada.');
    } catch {
      setError('Não foi possível desconectar. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo(
    () => ({ status, loading, busy, message, error, reproduz, connect, disconnect, refresh }),
    [status, loading, busy, message, error, reproduz, connect, disconnect, refresh],
  );

  return <SpotifyAccountContext.Provider value={value}>{children}</SpotifyAccountContext.Provider>;
}

export function useSpotifyAccount(): SpotifyAccountValue {
  const ctx = useContext(SpotifyAccountContext);
  if (!ctx) throw new Error('useSpotifyAccount precisa do SpotifyAccountProvider');
  return ctx;
}

export { spotifyReproduzAqui };
