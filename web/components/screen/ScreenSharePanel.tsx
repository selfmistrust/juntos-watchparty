'use client';

import { MonitorPlay, Rectangle, Square } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Portal } from '@/components/ui/Portal';
import { Button } from '@/components/ui/Button';
import { desktop, type CaptureSource } from '@/lib/desktop';
import type { StreamController } from '@/hooks/useStreamBridge';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Publica a captura na sala. Injetado em vez de importado direto porque quem
   * tem a ponte é a página, que é onde o palco consome a mídia — manter o hook
   * aqui criaria uma segunda ponte, com conexões WebRTC duplicadas.
   */
  bridge: StreamController;
}

/**
 * Seletor de tela para o app desktop.
 *
 * Só existe dentro do Electron: no navegador a fonte segue marcada como
 * indisponível, porque transmitir exige sinalização no servidor e o caminho
 * `getDisplayMedia` do Chrome entrega a imagem só para a própria aba.
 *
 * O `MediaStream` é pedido **depois** da escolha, e é isso que dá a
 * pré-visualização: o processo principal já sabe qual fonte foi marcada, e o
 * `getDisplayMedia` devolve o fluxo sem abrir nenhuma caixa do sistema — por
 * isso o seletor é o nosso, e não o do Windows.
 */
export function ScreenSharePanel({ open, onClose, bridge }: Props) {
  const api = desktop();
  const [fontes, setFontes] = useState<CaptureSource[]>([]);
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [transmitindo, setTransmitindo] = useState(false);
  // `| null` explícito: sem ele o TypeScript infere `RefObject`, cujo `current`
  // é somente-leitura, e o callback ref não pode escrever nele.
  const videoRef = useRef<HTMLVideoElement | null>(null);  const streamRef = useRef<MediaStream | null>(null);

  const listar = useCallback(async () => {
    if (!api) return;
    setCarregando(true);
    setErro(null);
    try {
      const lista = await api.listCaptureSources();
      setFontes(lista);
      setEscolhida((atual) => atual ?? lista[0]?.id ?? null);
      if (!lista.length) setErro('Nenhuma tela ou janela disponível para capturar.');
    } catch {
      setErro('Não foi possível listar as telas. Tente de novo.');
    } finally {
      setCarregando(false);
    }
  }, [api]);

  useEffect(() => {
    if (open) void listar();
  }, [open, listar]);

  /** Encerra a transmissão e devolve os controles de tela ao sistema. */
  const parar = useCallback(async () => {
    // Primeiro tira da sala, depois solta a captura. Ao contrário, o servidor
    // continuaria achando que existe transmissão para entregar enquanto a tela
    // já estava desligada.
    bridge.parar();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTransmitindo(false);
    await api?.stopCapture();
  }, [api, bridge]);

  // Sair do painel sem parar antes deixaria a luz de "transmitindo" acesa no
  // Windows com nada consumindo o fluxo — a tela continuaria congelada para o
  // sistema, e a próxima tentativa de captura falharia.
  useEffect(() => {
    if (!open && transmitindo) void parar();
  }, [open, transmitindo, parar]);

  // Fechar a janela do app tem que devolver a captura, senão o SO acha que o
  // app continua gravando a tela.
  useEffect(() => {
    const aoSair = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    window.addEventListener('beforeunload', aoSair);
    return () => window.removeEventListener('beforeunload', aoSair);
  }, []);

  /**
   * Anexa o fluxo ao `<video>` quando ele **sobe**.
   *
   * Não dá para fazer isso logo depois do `getDisplayMedia`: neste momento o
   * JSX ainda está mostrando a lista de fontes, e o `<video>` só entra no DOM
   * no render seguinte, disparado pelo `setTransmitindo`. Guardar o `srcObject`
   * num elemento que ainda não existe era o que deixava a pré-visualização
   * permanentemente preta — o `readyState` ficava em 0 para sempre.
   *
   * O callback ref resolve as duas ordens: ele roda quando o elemento monta,
   * independente de o fluxo ter chegado antes ou depois.
   */
  const anexarVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    const stream = streamRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    // Muted e playsInline juntos: sem muted o autoplay é bloqueado, e sem
    // playsInline o iOS abre o vídeo em tela cheia.
    el.muted = true;
    el.playsInline = true;
    void el.play().catch(() => undefined);
  }, []);

  const comecar = useCallback(async () => {
    if (!api || !escolhida) return;
    setErro(null);
    try {
      await api.selectCaptureSource(escolhida);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streamRef.current = stream;

      // A pessoa pode parar pelo próprio SO (a barra de compartilhamento do
      // Windows). O `track.onended` é o único jeito de saber disso — e sem
      // tratar, a sala ficaria com uma transmissão que nunca mais chega mídia.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => void parar());

      // A captura local sozinha não é transmissão: é preciso registrá-la na
      // sala, que é quem vai parear as conexões WebRTC.
      await bridge.publicar(stream, 'Tela compartilhada');
      setTransmitindo(true);
    } catch {
      setErro('Não foi possível iniciar a captura. Tente outra tela.');
      await api.stopCapture();
    }
  }, [api, bridge, escolhida, parar]);

  if (!open || !api) return null;

  return (
    <Portal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compartilhar tela"
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center"
        onClick={onClose}
      >
        <div
          className="animate-fade-up w-full max-w-2xl overflow-hidden rounded-2xl border border-hairline bg-surface shadow-lift"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
            <MonitorPlay size={17} className="text-ink-muted" />
            <h2 className="text-sm font-medium text-ink">Compartilhar tela</h2>
            <button
              type="button"
              onClick={() => {
                void parar();
                onClose();
              }}
              className="ml-auto rounded-md px-2 py-1 text-2xs text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              Fechar
            </button>
          </header>

          <div className="p-4">
            {/*
              * A pré-visualização ocupa o lugar do seletor enquanto transmite.
              * Trocar de fonte no meio exigiria parar e pedir o fluxo de novo,
              * e o ganho não compensa a perda do que já estava rodando.
              */}
            {transmitindo ? (
              <div className="overflow-hidden rounded-xl border border-hairline bg-black">
                <video
                  ref={anexarVideo}
                  className="aspect-video w-full"
                  // O vídeo é a prévia da captura, não um vídeo do app.
                  aria-label="Pré-visualização da tela compartilhada"
                />
              </div>
            ) : carregando ? (
              <p className="py-10 text-center text-sm text-ink-faint">Procurando telas…</p>
            ) : (
              <ul className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {fontes.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setEscolhida(f.id)}
                      aria-pressed={escolhida === f.id}
                      className={clsx(
                        'w-full overflow-hidden rounded-lg border text-left transition-colors duration-150',
                        escolhida === f.id
                          ? 'border-accent bg-accent-soft/20'
                          : 'border-hairline bg-raised hover:border-white/20',
                      )}
                    >
                      {f.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={f.thumbnail} alt="" className="aspect-video w-full object-cover" />
                      ) : (
                        <span className="flex aspect-video items-center justify-center bg-black/25 text-ink-faint">
                          <MonitorPlay size={22} />
                        </span>
                      )}
                      <span className="flex items-center gap-1.5 px-2 py-1.5">
                        {f.kind === 'screen' ? (
                          <Rectangle size={12} className="shrink-0 text-ink-faint" />
                        ) : (
                          <Square size={12} className="shrink-0 text-ink-faint" />
                        )}
                        <span className="truncate text-2xs text-ink-muted">{f.name}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {erro && <p className="mt-3 text-2xs leading-relaxed text-live/90">{erro}</p>}

            <p className="mt-3 text-2xs leading-relaxed text-ink-faint">
              {transmitindo
                ? 'A tela vai para quem está na sala. Sem um servidor TURN, quem estiver em outra rede pode não conseguir ver.'
                : 'Escolha uma tela ou janela. O áudio do sistema só é capturado no Windows.'}
            </p>
          </div>

          <footer className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
            {transmitindo ? (
              <Button onClick={() => void parar()}>Parar de compartilhar</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={listar} disabled={carregando}>
                  Atualizar
                </Button>
                <Button onClick={() => void comecar()} disabled={!escolhida || carregando}>
                  Começar a capturar
                </Button>
              </>
            )}
          </footer>
        </div>
      </div>
    </Portal>
  );
}
