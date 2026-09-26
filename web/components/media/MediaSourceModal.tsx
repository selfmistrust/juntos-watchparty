'use client';

import clsx from 'clsx';
import { CheckCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Portal } from '@/components/ui/Portal';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { useYoutubeSource } from '@/lib/mediaSources/useYoutubeSource';
import { useScreenShare } from '@/lib/mediaSources/useScreenShare';
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
  /** Chamado quando o fluxo de uma fonte é iniciado com sucesso. */
  onSourceStarted?: (id: string) => void;
}

interface CardState {
  loading: boolean;
  available: boolean;
  reason?: string;
  starting: boolean;
  error?: string;
  /** 0–100, só para fontes que reportam progresso (upload). */
  progress?: number;
}

const idle: CardState = { loading: false, available: true, starting: false };

export function MediaSourceModal({
  open,
  onClose,
  canControl,
  addToPlaylist,
  requestUploadToken,
  onSourceStarted,
}: Props) {
  const [states, setStates] = useState<Record<string, CardState>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /**
   * Fontes do registro + as duas que vêm de hook porque abrem painel com
   * estado próprio: a busca do YouTube e o seletor de tela. As listas se
   * misturam aqui, num só lugar: o resto do modal não sabe a diferença.
   */
  const youtube = useYoutubeSource();
  const tela = useScreenShare();
  const sources = useMemo<MediaSourceProvider[]>(
    () =>
      MEDIA_SOURCES.flatMap((f) => {
        // O YouTube não está no registro: ele entra logo depois do Computador,
        // que é a ordem que o modal já tinha. Trocar a fonte do registro pela
        // versão do hook, mantendo o lugar, evita que um card suma da grade
        // quando uma fonte ganha painel próprio.
        if (f.id === 'upload') return [f, youtube.provider];
        if (f.id === 'screen') return [tela.provider];
        return [f];
      }),
    [youtube.provider, tela.provider],
  );

  const context = useRef<MediaSourceContext>({ canControl, addToPlaylist, requestUploadToken });
  context.current = {
    canControl,
    addToPlaylist,
    requestUploadToken,
    // O progresso volta para o card da fonte, que é onde a pessoa está olhando
    // enquanto o modal continua aberto durante o envio.
    onProgress: (sourceId, percent) => {
      setStates((prev) => {
        const atual = prev[sourceId];
        if (!atual?.starting) return prev;
        return { ...prev, [sourceId]: { ...atual, progress: percent } };
      });
    },
  };

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
          reason: source.controlReason ?? 'Só quem controla a fila pode usar esta fonte.',
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
  //
  // `sources` também é dependência: conectar ou desconectar troca a identidade
  // do provider enquanto o modal está aberto, e sem isso o card ficaria
  // mostrando o status velho. Não entra em loop porque `sources` é memoizado e
  // só muda de identidade quando a conta muda de verdade.
  refreshRef.current = refresh;
  useEffect(() => {
    if (!open) return;
    setStates({});
    void refreshRef.current?.();
  }, [open, sources]);

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

      setStates((prev) => ({ ...prev, [source.id]: { ...(prev[source.id] ?? idle), starting: true, error: undefined, progress: 0 } }));
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

  // Os painéis do YouTube e da tela vivem fora do `if (!open)`: cada um é um
  // modal próprio, que precisa continuar montado depois de o modal de
  // Aplicações fechar — inclusive porque o de tela fica aberto enquanto a
  // captura corre.
  const painelExtra: ReactNode = (
    <>
      {youtube.panel}
      {tela.panel}
    </>
  );

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
          'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors duration-150',
          // `h-full` só sem a linha de conta: com ela, o `100%` passing a
          // incluir a linha de baixo e o botão esticaria por cima dela. A
          // uniformidade entre cards vem do `stretch` do grid no wrapper.
          !source.account && 'h-full',
          bloqueado
            ? 'cursor-not-allowed border-hairline bg-raised/40 opacity-60'
            : 'border-hairline bg-raised hover:border-accent/50 hover:bg-hover',
          state.error && 'border-live/50',
          // Com conta embaixo, o card precisa da borda: os dois blocos ficam
          // parted pelo `overflow-hidden` do wrapper abaixo.
          source.account && 'rounded-b-none border-b-0',
        )}
      >
        <span
          className={clsx(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-black/25',
            // A cor da marca continua aparecendo quando a fonte está
            // indisponível: o `opacity-60` do card e o selo "Indisponível" já
            // dizem o bastante, e um ícone cinza perde justamente o que faz o
            // card ser reconhecível — a marca.
            source.accent ?? 'text-ink',
          )}
        >
          {source.icon}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <TruncatedText text={source.name} className="text-sm font-medium text-ink" />
            {state.loading && <span className="h-1.5 w-1.5 shrink-0 animate-blink rounded-full bg-accent" />}
          </span>
          {/*
            * A linha de baixo vai a duas linhas e para. A descrição de uma
            * fonte nova pode ser longa, e o card é meia largura no desktop:
            * sem teto, um texto bem escrito empurrava o card para baixo e
            * desalinhava a grade. Duas linhas cobrem as descrições de hoje, e
            * o `TruncatedText` põe o `title` quando a segunda linha ainda
            * cortou algo.
            */}
          <TruncatedText
            text={
              state.starting && state.progress !== undefined
                ? `Enviando… ${state.progress}%`
                : bloqueado && state.reason
                  ? state.reason
                  : source.description
            }
            className="mt-0.5 block text-2xs leading-relaxed text-ink-faint"
            lineClamp={2}
          />
          {bloqueado && (
            <span className="mt-1.5 inline-flex items-center rounded-full bg-hover px-1.5 py-0.5 text-[0.625rem] font-medium text-ink-faint">
              Indisponível
            </span>
          )}
          {state.starting && state.progress !== undefined && (
            <span
              role="progressbar"
              aria-valuenow={state.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Enviando para ${source.name}`}
              className="mt-1.5 block h-1 overflow-hidden rounded-full bg-hover"
            >
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${state.progress}%` }}
              />
            </span>
          )}
        </span>
      </button>

      {/*
        * A conta é gerenciada aqui e em mais lugar nenhum do app. Ela fica
        * *fora* do `<button>` de cima porque botão dentro de botão é HTML
        * inválido, e o botão de conectar precisa ser clicável por conta
        * própria.
        */}
      {source.account && <AccountRow account={source.account} />}

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

/**
 * Status da conta e os botões de conectar/desconectar de uma fonte.
 *
 * Não sabe nada da integração: lê o que o provider declarou em `account`. Uma
 * fonte nova que exija login aparece aqui sem nenhuma linha nova neste arquivo.
 */
function AccountRow({ account }: { account: NonNullable<MediaSourceProvider['account']> }) {
  const [trocando, setTrocando] = useState(false);

  const ocupado = Boolean(account.busy) || trocando;

  return (
    <div
      className={clsx(
        'rounded-b-xl border border-t-0 px-3 py-2',
        account.connected ? 'border-hairline bg-raised' : 'border-hairline bg-raised/60',
      )}
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
             * Este texto quebra em duas linhas em vez de ser cortado: o card é
             * meia largura no desktop, e "Nenhuma conta conectada" não cabe ao
             * lado do botão. Cortar mostrava "Nenhuma conta conect…", que é
             * pior que quebrar — o nome do canal, quando existe, é curto e
             * continua em uma linha só.
             */
            <span className="min-w-0 text-2xs leading-snug text-ink-faint">
              {account.configured
                ? 'Nenhuma conta conectada'
                : 'Integração não configurada no servidor'}
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
