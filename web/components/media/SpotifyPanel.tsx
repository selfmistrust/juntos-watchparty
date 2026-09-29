'use client';

import { MagnifyingGlass, MusicNotes, WaveTriangle, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Portal } from '@/components/ui/Portal';
import { Button } from '@/components/ui/Button';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { SourceAccountRow } from '@/components/media/SourceAccountRow';
import {
  listSpotifyTracks,
  searchSpotify,
  SpotifyErro,
  type SpotifyItem,
} from '@/lib/spotifyAccount';
import { textoDoMotivo, type MotivoDoAudio } from '@/lib/spotifyPlayback';
import type { MediaSourceAccount, MediaSourceContext } from '@/lib/mediaSources';

interface Props {
  open: boolean;
  onClose: () => void;
  context: MediaSourceContext;
  /** Mesmo objeto que o `description` do card usa, para os dois não divergirem. */
  account: MediaSourceAccount;
  /**
   * Motivo do áudio, para o painel avisar **antes** da pessoa escolher a música.
   *
   * Um plano sem Premium não descobre que não toca quando a música começa: ela
   * só vê que o silêncio continua. Dizer no painel é a diferença entre "isto
   * aqui não vai tocar" e "isto aqui está quebrado".
   */
  motivo: MotivoDoAudio;
}

/**
 * Busca do Spotify.
 *
 * ## Faixa, álbum e playlist na mesma lista
 *
 * A busca devolve os três e eles aparecem juntos, cada um com o seu subtítulo.
 * Separar em abas esconderia o que a pessoa normalmente procura — a música —
 * atrás de dois clique extras, e o Spotify indexa por relevância, então a faixa
 * que casou já vem primeiro.
 *
 * Álbum e playlist são **containers de faixas**, e não faixas: clicar neles abre
 * a lista de dentro, e é de lá que a pessoa escolhe o que entra na fila. Tocar o
 * disco inteiro exigiria `PUT /me/player/play` direto na Web API com o token da
 * pessoa no navegador — um segundo caminho de áudio, fora do SDK, que o Spotify
 * não autoriza e que a fila não precisa, porque a fila é de faixas.
 *
 * ## Por que o layout é o do YouTube, palavra por palavra
 *
 * As classes do painel, da barra de busca e dos itens são as mesmas do
 * `YoutubeSearchPanel`, de propósito. Dois painéis de busca com formatos
 * diferentes lêem como dois produtos: a pessoa aprende o formato de um e erra no
 * outro. A diferença real entre as duas fontes é o que acontece com o resultado
 * escolhido, e isso não é layout.
 */
export function SpotifyPanel({ open, onClose, context, account, motivo }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SpotifyItem[]>([]);
  const [container, setContainer] = useState<{ item: SpotifyItem; faixas: SpotifyItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const value = query.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setContainer(null);
    try {
      setResults(await searchSpotify(value));
    } catch (e) {
      /*
       * A mensagem do servidor já é uma frase em português, escrita com o status
       * do Spotify em mãos. O que este bloco acrescenta é a **ação**, e ela
       * depende do status:
       *
       *   401  o token foi recusado. "Tente de novo" não resolve: é preciso
       *        reconectar, porque o refresh token também foi rejeitado.
       *   429  limite de requisições. Repetir agora é o que gasta a cota.
       *
       * Sem isso, os dois viravam "tente de novo" e a pessoa clicava de novo sem
       * chance de o resultado mudar.
       */
      if (e instanceof SpotifyErro) {
        setError(
          e.statusDoSpotify === 401
            ? `${e.message} Use "Trocar de conta" para autorizar de novo.`
            : e.statusDoSpotify === 429
              ? `${e.message} Espere alguns minutos antes de buscar de novo.`
              : e.message,
        );
      } else {
        setError('A busca não respondeu. Tente de novo.');
      }
    } finally {
      setLoading(false);
    }
  }, [query]);

  const abrirContainer = useCallback(async (item: SpotifyItem) => {
    if (!item.uri) return;
    setLoading(true);
    setError(null);
    try {
      setContainer({ item, faixas: await listSpotifyTracks(item.uri) });
    } catch {
      setError('Não foi possível abrir essa lista. Tente de novo.');
    } finally {
      setLoading(false);
    }
  }, []);

  const adicionar = useCallback(
    (faixa: SpotifyItem) => {
      if (!faixa.trackUri) return;
      /*
       * `src` fica vazio, e não é esquecimento: **o Spotify não tem URL de
       * áudio**. O som vem do Web Playback SDK, direto para o navegador de cada
       * pessoa. Um `src` aqui seria uma URL que não existe, e o player cairia
       * num caminho de `<video>` que nunca vai tocar.
       */
      context.addToPlaylist({
        kind: 'spotify',
        src: '',
        spotifyUri: faixa.trackUri,
        spotifyDurationMs: faixa.durationMs,
        title: faixa.title,
        thumbnail: faixa.artwork ?? undefined,
      });
      onClose();
    },
    [context, onClose],
  );

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setContainer(null);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const podeBuscar = account.configured && account.connected;
  const aviso = textoDoMotivo(motivo, account.connected);

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Buscar no Spotify"
          className="animate-fade-up flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-lift sm:rounded-2xl"
        >
          <div className="flex items-center gap-2 border-b border-hairline p-3">
            <div className="flex min-w-0 max-w-[28rem] flex-1 items-center gap-2 rounded-xl border border-hairline bg-raised pl-3 pr-1.5 transition-colors duration-150 focus-within:border-accent/60">
              <MagnifyingGlass size={16} className="shrink-0 text-ink-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                placeholder="Buscar músicas, álbuns e playlists"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={!query.trim() || loading}
                className="h-7 shrink-0 px-2.5"
              >
                {loading ? <WaveTriangle size={14} className="animate-pulse" /> : 'Buscar'}
              </Button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar busca"
              className="ml-auto shrink-0 rounded-md p-2 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink [@media(pointer:coarse)]:p-2.5"
            >
              <X size={16} />
            </button>
          </div>

          <div className="border-b border-hairline p-3">
            <SourceAccountRow account={account} className="border-0 bg-transparent p-0" />
            {/*
             * O aviso de plano fica **abaixo** da conta, e não no card do modal
             * de Aplicações: o card tem duas linhas de descrição e uma delas é o
             * estado da conta. Sobrar uma linha aqui é o que dá a este painel a
             * responsabilidade de dizer "a busca funciona, o áudio não", que é
             * a informação que decide se a pessoa vai usar a fonte.
             */}
            {aviso && (
              <p className="mt-2 flex items-start gap-1.5 text-2xs leading-relaxed text-ink-faint">
                <MusicNotes size={13} className="mt-px shrink-0 text-[#1DB954]" />
                {aviso}
              </p>
            )}
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {error && <p className="animate-fade-up p-3 text-2xs leading-relaxed text-live/90">{error}</p>}

            {!podeBuscar && !error && (
              <div className="p-3">
                <p className="text-2xs leading-relaxed text-ink-faint">
                  {account.configured
                    ? 'Sem uma conta conectada, a busca não roda. Conecte a sua conta aqui — cada pessoa usa a própria, e só ouve se tiver Spotify Premium.'
                    : 'A integração com o Spotify ainda não está configurada no servidor.'}
                </p>
              </div>
            )}

            {podeBuscar && container && (
              <>
                <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setContainer(null)}
                    className="shrink-0 rounded-md px-1.5 py-1 text-2xs text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink"
                  >
                    ← {container.item.title}
                  </button>
                </div>
                <ul className="p-2">
                  {container.faixas.map((f) => (
                    <Item
                      key={f.id}
                      item={f}
                      onPick={() => adicionar(f)}
                      detalhe={`${Math.floor((f.durationMs ?? 0) / 60000)}:${String(
                        Math.floor(((f.durationMs ?? 0) % 60000) / 1000),
                      ).padStart(2, '0')}`}
                    />
                  ))}
                </ul>
                {container.faixas.length === 0 && (
                  <p className="px-4 py-8 text-center text-2xs leading-relaxed text-ink-faint">
                    Nada para tocar nesta lista.
                  </p>
                )}
              </>
            )}

            {podeBuscar && !container && results.length > 0 && (
              <ul className="p-2">
                {results.map((r) =>
                  r.kind === 'track' ? (
                    <li key={r.id}>
                      <Item item={r} onPick={() => adicionar(r)} />
                    </li>
                  ) : (
                    <li key={r.id}>
                      <Item item={r} onPick={() => void abrirContainer(r)} />
                    </li>
                  ),
                )}
              </ul>
            )}

            {podeBuscar && !container && results.length === 0 && !error && !loading && query.trim() === '' && (
              <p className="px-4 py-8 text-center text-2xs leading-relaxed text-ink-faint">
                Busque por uma música, um álbum ou uma playlist.
              </p>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** Uma linha de resultado. Mesma anatomia do item do YouTube. */
function Item({
  item,
  onPick,
  detalhe,
}: {
  item: SpotifyItem;
  onPick: () => void;
  detalhe?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150 hover:bg-hover [@media(pointer:coarse)]:py-3"
    >
      {item.artwork ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.artwork}
          alt=""
          className="h-10 w-[4.4rem] shrink-0 rounded object-cover"
        />
      ) : (
        <span className="flex h-10 w-[4.4rem] shrink-0 items-center justify-center rounded bg-raised text-ink-faint">
          <MusicNotes size={16} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <TruncatedText
          text={item.title}
          lineClamp={2}
          className="block text-[0.8125rem] leading-snug text-ink"
        />
        <TruncatedText
          text={detalhe ? `${item.subtitle} · ${detalhe}` : item.subtitle}
          className="block text-2xs text-ink-faint"
        />
      </span>
    </button>
  );
}
