'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Portal } from '@/components/ui/Portal';
import { useYoutubeSource } from '@/lib/mediaSources/useYoutubeSource';
import {
  MEDIA_SOURCES,
  type MediaSourceContext,
  type MediaSourceProvider,
  type MediaSourceState,
} from '@/lib/mediaSources';

interface Props {
  open: boolean;
  onClose: () => void;
  canControl: boolean;
  addToPlaylist: MediaSourceContext['addToPlaylist'];
  requestUploadToken: MediaSourceContext['requestUploadToken'];
  /** Fonte a abrir já com o fluxo iniciado (usado pelo atalho do painel da fila). */
  initialSourceId?: string | null;
  /** Chamado quando o fluxo de uma fonte é iniciado com sucesso. */
  onSourceStarted?: (id: string) => void;
}

interface CardState {
  loading: boolean;
  available: boolean;
  reason?: string;
  starting: boolean;
  error?: string;
}

const idle: CardState = { loading: false, available: true, starting: false };

export function MediaSourceModal({
  open,
  onClose,
  canControl,
  addToPlaylist,
  requestUploadToken,
  initialSourceId,
  onSourceStarted,
}: Props) {
  const [states, setStates] = useState<Record<string, CardState>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /**
   * Fontes do registro + o YouTube, que vem de um hook porque a busca dele
   * precisa abrir um painel com estado próprio. As duas listas se misturam
   * aqui, num só lugar: o resto do modal não sabe a diferença.
   */
  const youtube = useYoutubeSource();
  const sources = useMemo<MediaSourceProvider[]>(
    () => [MEDIA_SOURCES[0], youtube.provider, ...MEDIA_SOURCES.slice(1)],
    [youtube.provider],
  );

  const context = useRef<MediaSourceContext>({ canControl, addToPlaylist, requestUploadToken });
  context.current = { canControl, addToPlaylist, requestUploadToken };

  /**
   * Consulta o estado de todas as fontes ao abrir. Uma fonte que responde
   * "indisponível" sabe explicar sozinha; o modal só guarda o resultado.
   *
   * `sources` entra na dependência, mas o efeito abaixo é separado de propósito
   * (ver `refreshRef`): sem isso, um provider que muda de identidade a cada
   * render dispararia a consulta em loop e os cards nunca sairiam de loading.
   */
  const refreshRef = useRef<() => Promise<void>>();

  const refresh = useCallback(async () => {
    if (!open) return;
    const collected: Record<string, CardState> = {};
    for (const source of sources) {
      if (source.requiresControl && !canControl) {
        collected[source.id] = {
          loading: false,
          available: false,
          reason: 'Só quem controla a fila pode usar esta fonte.',
          starting: false,
        };
      } else {
        collected[source.id] = source.resolveState
          ? { loading: true, available: true, starting: false }
          : idle;
      }
    }
    setStates(collected);

    // Cada card é resolvido por conta própria: uma fonte lenta não segura as
    // outras, e o `setStates` por id não sobrescreve o que já veio.
    await Promise.all(
      sources.map(async (source) => {
        if (!source.resolveState) return;
        if (source.requiresControl && !canControl) return;
        try {
          const state: MediaSourceState = await source.resolveState(context.current);
          setStates((prev) => ({
            ...prev,
            [source.id]: { ...(prev[source.id] ?? idle), ...state, loading: false },
          }));
        } catch {
          setStates((prev) => ({
            ...prev,
            [source.id]: {
              loading: false,
              available: false,
              reason: 'Não foi possível verificar esta fonte.',
              starting: false,
            },
          }));
        }
      }),
    );
  }, [open, canControl, sources]);

  // Só a abertura dispara a consulta. `refresh` é lido pela ref porque muda de
  // identidade sempre que `sources` muda, e depender dele aqui reiniciaria a
  // consulta a cada render, deixando os cards presos em loading.
  refreshRef.current = refresh;
  useEffect(() => {
    if (!open) return;
    setStates({});
    void refreshRef.current?.();
  }, [open]);

  // Guarda de onde o foco veio e devolve ao fechar — o modal é aberto por
  // botão, então sem isso o foco cai no body e o teclado perde o caminho.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    const anterior = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (anterior && document.contains(anterior)) {
      anterior.focus();
    }
  }, [open]);

  // Foca o primeiro card ao abrir, para o teclado já entrar no conteúdo.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    }, 40);
    return () => window.clearTimeout(id);
  }, [open]);

  // Escape fecha. `keydown` na janela pega mesmo com o foco em outro elemento.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // Prende o Tab dentro do modal enquanto ele estiver aberto.
      if (e.key !== 'Tab') return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const primeiro = focusables[0];
      const ultimo = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primeiro.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const start = useCallback(
    async (source: MediaSourceProvider) => {
      const estado = states[source.id];
      if (estado?.loading || estado?.starting) return;
      if (estado && !estado.available) return;
      if (!source.start) return;

      setStates((prev) => ({ ...prev, [source.id]: { ...(prev[source.id] ?? idle), starting: true, error: undefined } }));
      try {
        await source.start(context.current);
        onSourceStarted?.(source.id);
        onClose();
      } catch (err) {
        setStates((prev) => ({
          ...prev,
          [source.id]: {
            ...(prev[source.id] ?? idle),
            starting: false,
            error: err instanceof Error ? err.message : 'Algo deu errado.',
          },
        }));
      }
    },
    [states, onClose, onSourceStarted],
  );

  // Atalho: abre o modal já iniciando uma fonte (o botão da fila continua
  // funcionando e pula a etapa de escolher no modal).
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !initialSourceId) return;
    if (startedRef.current === initialSourceId) return;
    const source = sources.find((s) => s.id === initialSourceId);
    if (!source) return;
    if (source.requiresControl && !canControl) return;
    startedRef.current = initialSourceId;
    void start(source);
  }, [open, initialSourceId, canControl, start, sources]);

  useEffect(() => {
    if (!open) startedRef.current = null;
  }, [open]);

  // O painel do YouTube vive fora do `if (!open)`: ele é um modal próprio, que
  // precisa continuar montado depois de o modal de Aplicações fechar.
  const painelExtra: ReactNode = youtube.panel;

  if (!open) return <>{painelExtra}</>;

  return (
    <>
      <Portal>
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
          onMouseDown={(e) => {
            // Fecha só no clique no fundo; arrastar desde dentro não deve fechar.
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Escolher onde pegar o vídeo"
            className="animate-fade-up flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-lift sm:rounded-2xl"
          >
          <div className="flex items-start justify-between gap-3 border-b border-hairline p-4">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-ink">Adicionar à fila</h2>
              <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">
                Escolha de onde vem o vídeo. A sala inteira assiste junto.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="shrink-0 rounded-md p-2 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink [@media(pointer:coarse)]:p-2.5"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

            <div className="scroll-thin grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-4 sm:grid-cols-2">
              {sources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  state={states[source.id] ?? { loading: true, available: true, starting: false }}
                  onSelect={() => void start(source)}
                />
              ))}
            </div>
          </div>
        </div>
      </Portal>
      {painelExtra}
    </>
  );
}

function SourceCard({
  source,
  state,
  onSelect,
}: {
  source: MediaSourceProvider;
  state: CardState;
  onSelect: () => void;
}) {
  const bloqueado = !state.available;
  const ocupado = state.loading || state.starting;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onSelect}
        disabled={bloqueado || ocupado}
        aria-busy={ocupado || undefined}
        aria-describedby={state.error ? `${source.id}-erro` : undefined}
        className={clsx(
          'flex h-full w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors duration-150',
          bloqueado
            ? 'cursor-not-allowed border-hairline bg-raised/40 opacity-60'
            : 'border-hairline bg-raised hover:border-accent/50 hover:bg-hover',
          state.error && 'border-live/50',
        )}
      >
        <span
          className={clsx(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-black/25',
            bloqueado ? 'text-ink-faint' : (source.accent ?? 'text-ink'),
          )}
        >
          {source.icon}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-ink">{source.name}</span>
            {state.loading && <span className="h-1.5 w-1.5 shrink-0 animate-blink rounded-full bg-accent" />}
          </span>
          <span className="mt-0.5 block text-2xs leading-relaxed text-ink-faint">
            {bloqueado && state.reason ? state.reason : source.description}
          </span>
          {bloqueado && (
            <span className="mt-1.5 inline-flex items-center rounded-full bg-hover px-1.5 py-0.5 text-[0.625rem] font-medium text-ink-faint">
              Indisponível
            </span>
          )}
        </span>
      </button>

      {state.error && (
        <p
          id={`${source.id}-erro`}
          className="animate-fade-up mt-1.5 px-1 text-2xs leading-relaxed text-live/90"
        >
          {state.error}
        </p>
      )}
    </div>
  );
}
