'use client';

import { useEffect, useRef, useState } from 'react';
import { CloudArrowDown, FilmStrip, WarningCircle, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import { Portal } from '@/components/ui/Portal';
import { SourceAccountRow } from '@/components/media/SourceAccountRow';
import {
  downloadDriveVideo,
  fetchDrivePickerToken,
  fetchDriveVideo,
  type DriveVideo,
} from '@/lib/driveAccount';
import { escolherVideoNoGoogleDrive } from '@/lib/googlePicker';
import { escolherVideoNoNavegador } from '@/lib/driveBrowserPicker';
import { isDesktop } from '@/lib/desktop';
import type { MediaSourceAccount, MediaSourceContext } from '@/lib/mediaSources';

interface Props {
  open: boolean;
  onClose: () => void;
  context: MediaSourceContext;
  account: MediaSourceAccount;
  refreshAccount: () => Promise<void>;
}

type Fase = 'picker' | 'navegador' | 'metadata' | 'baixando' | 'enviando' | null;

const MENSAGENS_ERRO: Record<string, string> = {
  browser_open_failed: 'Não foi possível abrir o navegador. Tente de novo.',
  picker_expired: 'A seleção expirou. Abra o navegador novamente para escolher o vídeo.',
  picker_failed: 'Não foi possível concluir a seleção no navegador. Tente de novo.',
  picker_request_failed: 'Não foi possível consultar a seleção no navegador. Tente de novo.',
  timeout: 'O Google Drive demorou demais para responder. Tente de novo.',
  not_connected: 'A conta do Drive foi desconectada. Conecte de novo.',
  picker_not_configured: 'O Google Picker ainda não está configurado para este app.',
  picker_load_failed: 'Não foi possível abrir o Google Picker. Verifique sua conexão e tente de novo.',
  not_found: 'Esse vídeo não está mais disponível no seu Drive.',
  not_a_video: 'Escolha um arquivo de vídeo.',
  token_expired: 'A autorização do Drive expirou. Conecte novamente e selecione o vídeo.',
  drive_permission: 'Não foi possível acessar esse arquivo. Reabra o Picker e escolha outro vídeo.',
};

function tamanhoLegivel(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function duracaoLegivel(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function comTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 30_000);
    }),
  ]).finally(() => clearTimeout(timer!));
}

/** Escolhe um vídeo com o Google Picker e copia-o para o bucket da sala. */
export function DrivePickerPanel({ open, onClose, context, account, refreshAccount }: Props) {
  const [erro, setErro] = useState<string | null>(null);
  const [video, setVideo] = useState<DriveVideo | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [progresso, setProgresso] = useState(0);
  const [fase, setFase] = useState<Fase>(null);
  const operacao = useRef<AbortController | null>(null);
  const externo = isDesktop();

  useEffect(() => () => {
    operacao.current?.abort();
    operacao.current = null;
  }, []);

  const fechar = () => {
    operacao.current?.abort();
    onClose();
  };

  const copiarParaASala = async (arquivo: DriveVideo, accessToken: string, signal: AbortSignal) => {
    setVideo(arquivo);
    setFase('baixando');
    setProgresso(0);

    const resposta = await comTimeout(downloadDriveVideo(arquivo.id, accessToken, signal));
    const total = Number(resposta.headers.get('content-length') ?? arquivo.size ?? 0);
    const corpo = await (async () => {
      if (!resposta.body || !total) return await resposta.arrayBuffer();
      const leitor = resposta.body.getReader();
      const partes: Uint8Array[] = [];
      let recebido = 0;
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        if (value) {
          partes.push(value);
          recebido += value.byteLength;
          setProgresso(Math.min(99, Math.round((recebido / total) * 100)));
        }
      }
      return new Blob(partes as BlobPart[]).arrayBuffer();
    })();
    signal.throwIfAborted();
    const arquivoLocal = new File([corpo], arquivo.name, { type: arquivo.mimeType });

    setFase('enviando');
    setProgresso(0);
    const token = await context.requestUploadToken({
      fileName: arquivo.name,
      fileSize: arquivoLocal.size,
      mimeType: arquivo.mimeType,
    });
    signal.throwIfAborted();
    if (!token.ok) throw new Error(token.error);

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abortar = () => xhr.abort();
      const concluir = (error?: Error) => {
        signal.removeEventListener('abort', abortar);
        if (error) reject(error);
        else resolve();
      };
      xhr.open('PUT', token.uploadUrl);
      xhr.setRequestHeader('Content-Type', token.contentType);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgresso(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300 ? concluir() : concluir(new Error('upload_failed'));
      xhr.onerror = () => concluir(new Error('upload_failed'));
      xhr.onabort = () => concluir(new DOMException('Envio cancelado', 'AbortError'));
      signal.addEventListener('abort', abortar, { once: true });
      xhr.send(arquivoLocal);
    });

    signal.throwIfAborted();
    context.addToPlaylist({
      kind: 'file',
      src: token.publicUrl,
      title: arquivo.name.replace(/\.[^./]+$/, '') || arquivo.name,
      duration: arquivo.durationMs ? Math.round(arquivo.durationMs / 1000) : undefined,
    });
    onClose();
  };

  const escolherVideo = async () => {
    if (operacao.current) return;
    const controller = new AbortController();
    operacao.current = controller;
    const { signal } = controller;
    setErro(null);
    setVideo(null);
    setOcupado(true);
    setFase('picker');
    try {
      let fileId: string | null;
      if (externo) {
        fileId = await escolherVideoNoNavegador(signal, () => setFase('navegador'));
        if (!signal.aborted) void refreshAccount();
      } else {
        const pickerToken = await comTimeout(fetchDrivePickerToken(signal));
        // O prazo de rede não se aplica ao tempo que a pessoa leva para escolher.
        fileId = await escolherVideoNoGoogleDrive(pickerToken, signal);
      }
      if (!fileId || signal.aborted) return;

      // Reconsulta o token depois da seleção para que uma sessão longa no Picker
      // não deixe o download começar com um access token prestes a expirar.
      setFase('metadata');
      const accessToken = await comTimeout(fetchDrivePickerToken(signal));
      const arquivo = await comTimeout(fetchDriveVideo(fileId, accessToken, signal));
      signal.throwIfAborted();
      await copiarParaASala(arquivo, accessToken, signal);
    } catch (e) {
      if (signal.aborted) return;
      const motivo = e instanceof Error ? e.message : '';
      if (motivo === 'not_connected') void refreshAccount();
      setErro(
        MENSAGENS_ERRO[motivo] ?? 'Não foi possível copiar o vídeo do Drive. Tente de novo.',
      );
    } finally {
      controller.abort();
      if (operacao.current === controller) {
        operacao.current = null;
        setOcupado(false);
        setFase(null);
        setVideo(null);
        setProgresso(0);
      }
    }
  };

  if (!open) return null;

  const rotulos: Record<Exclude<Fase, null>, string> = {
    picker: externo ? 'Abrindo navegador' : 'Abrindo Google Picker',
    navegador: 'Aguardando seleção no navegador',
    metadata: 'Preparando o vídeo',
    baixando: 'Baixando do Drive',
    enviando: 'Enviando para a sala',
  };
  const metadados = video && [duracaoLegivel(video.durationMs), tamanhoLegivel(video.size)]
    .filter(Boolean)
    .join(' · ');

  return (
    <Portal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Escolher vídeo do Google Drive"
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && (!ocupado || fase === 'navegador')) fechar();
        }}
      >
        <div className="animate-fade-up flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-lift sm:rounded-2xl">
          <div className="flex items-center gap-3 border-b border-hairline p-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/25 text-ink-faint">
              {ocupado ? <CloudArrowDown size={18} className="animate-pulse text-accent" /> : <FilmStrip size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-ink">Google Drive</h2>
              <p className="text-2xs leading-relaxed text-ink-faint">
                Selecione um vídeo; ele será copiado para a sala.
              </p>
            </div>
            <button
              type="button"
              onClick={fechar}
              disabled={ocupado && fase !== 'navegador'}
              aria-label="Fechar"
              className="shrink-0 rounded-md p-2 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
            <fieldset disabled={ocupado} className="min-w-0">
              <SourceAccountRow account={account} className="border-0 bg-transparent p-0" />
            </fieldset>

            {!account.configured && (
              <p className="mt-3 text-2xs leading-relaxed text-ink-faint">
                {externo
                  ? 'A integração precisa do OAuth do Google Drive na configuração do servidor.'
                  : 'A integração precisa do OAuth do Drive no servidor e da chave e do número do projeto Google Picker na configuração do app.'}
              </p>
            )}

            {erro && (
              <p className="mt-3 flex items-start gap-2 text-2xs leading-relaxed text-live/90">
                <WarningCircle size={14} className="mt-px shrink-0" />
                {erro}
              </p>
            )}

            {ocupado && (
              <div className="mt-5 rounded-xl border border-hairline bg-raised/60 p-3">
                <p className="truncate text-sm text-ink">{video?.name ?? rotulos[fase ?? 'picker']}</p>
                {metadados && <p className="mt-0.5 text-2xs text-ink-faint">{metadados}</p>}
                {fase === 'navegador' && (
                  <>
                    <p role="status" className="mt-2 text-2xs leading-relaxed text-ink-faint">
                      Escolha o vídeo na aba do Google e volte para o Juntos. A cópia continuará aqui.
                      Se fechar a aba, cancele esta seleção para tentar novamente.
                    </p>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => operacao.current?.abort()}>
                      Cancelar seleção
                    </Button>
                  </>
                )}
                {(fase === 'baixando' || fase === 'enviando') && (
                  <>
                    <p className="mt-2 text-2xs text-accent">
                      {fase ? rotulos[fase] : 'Trabalhando'} — {progresso}%
                    </p>
                    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-hover">
                      <span
                        className="block h-full rounded-full bg-accent transition-[width] duration-200"
                        style={{ width: `${progresso}%` }}
                      />
                    </span>
                  </>
                )}
              </div>
            )}

            <Button
              onClick={() => void escolherVideo()}
              disabled={ocupado || account.busy || !account.configured || (!externo && !account.connected)}
              className="mt-4 w-full"
            >
              {ocupado ? (fase ? rotulos[fase] : 'Trabalhando…') : externo ? 'Escolher vídeo no navegador' : 'Escolher vídeo no Google Drive'}
            </Button>
          </div>

          <p className="border-t border-hairline px-4 py-2.5 text-2xs leading-relaxed text-ink-faint">
            O app só acessa arquivos escolhidos no Picker. O vídeo é copiado para o bucket da sala;
            os outros participantes não precisam de acesso ao seu Drive.
          </p>
        </div>
      </div>
    </Portal>
  );
}
