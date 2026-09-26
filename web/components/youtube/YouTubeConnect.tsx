import { YoutubeLogo } from '@phosphor-icons/react';
import { useYouTubeAccount } from '@/hooks/useYouTubeAccount';

/**
 * Conta do YouTube da pessoa.
 *
 * Fica só aqui, no perfil. A busca de vídeos é uma opção do modal de
 * Aplicações; manter o controle de conta também na aba Fila duplicava a mesma
 * integração em dois lugares e poluía o topo da fila.
 */
export function YouTubeConnect() {
  const { status, loading, busy, message, error, connect, disconnect } = useYouTubeAccount();

  if (loading) {
    return (
      <div className="rounded-xl border border-hairline bg-raised/60 p-3">
        <p className="text-2xs text-ink-faint">Verificando YouTube…</p>
      </div>
    );
  }

  if (!status.configured && !status.connected) {
    if (message || error) {
      return <p className="text-2xs text-live/90">{error ?? message}</p>;
    }
    return null;
  }

  return (
    <div className="mt-3 rounded-xl border border-hairline bg-raised/60 p-3">
      <div className="flex items-start gap-2.5">
        <YoutubeLogo size={18} weight="fill" className="mt-0.5 shrink-0 text-live" />
        <div className="min-w-0 flex-1">
          {status.connected ? (
            <>
              <p className="text-sm text-ink">YouTube conectado</p>
              {status.channelTitle && (
                <p className="mt-0.5 truncate text-2xs text-ink-faint">{status.channelTitle}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-ink">Conta do YouTube</p>
              <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">
                Conecte sua conta para buscar e usar o YouTube com a sua autenticação.
              </p>
            </>
          )}
        </div>
        {status.connected ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
            className="shrink-0 rounded-lg border border-hairline px-2.5 py-1 text-2xs text-ink-muted transition-colors duration-150 hover:border-white/20 hover:text-ink disabled:opacity-40"
          >
            {busy ? 'Saindo…' : 'Desconectar'}
          </button>
        ) : (
          <button
            type="button"
            onClick={connect}
            className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-2xs text-white transition-colors duration-150 hover:bg-accent/90"
          >
            Conectar YouTube
          </button>
        )}
      </div>
      {message && <p className="text-2xs text-ink-muted">{message}</p>}
      {error && <p className="text-2xs text-live/90">{error}</p>}
    </div>
  );
}
