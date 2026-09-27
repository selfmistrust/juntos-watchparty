'use client';

import { useCallback, useEffect, useState } from 'react';
import { CloudArrowDown, FilmStrip, MagnifyingGlass, WarningCircle, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import { Portal } from '@/components/ui/Portal';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { listarVideosDrive, pedirDownload, type DriveVideo } from '@/lib/driveAccount';
import type { MediaSourceContext } from '@/lib/mediaSources';

interface Props {
  open: boolean;
  onClose: () => void;
  context: MediaSourceContext;
}

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

/**
 * Escolhe um vídeo do Drive e o copia para o bucket da sala.
 *
 * ## Por que a cópia, e não um link
 *
 * Um arquivo do Drive é privado, e o token de quem o escolheu não viaja para os
 * outros participantes. Se a faixa apontasse para o Drive, seria um item que
 * só o dono toca. E o Drive não tem URL de vídeo reproduzível: o
 * `uc?export=download` devolve uma página HTML de confirmação assim que o
 * arquivo passa de algumas dezenas de MB.
 *
 * Então o arquivo é baixado do Drive e subido no bucket da sala, os dois
 * pelo navegador de quem escolheu. O Render não vê o vídeo, a faixa entra como
 * `kind: 'file'` com a URL do R2, e nada no player muda. Os outros
 * participantes veem exatamente o que veem num envio comum.
 *
 * ## Por que isso consome cota
 *
 * Baixar do Drive pela API conta contra a cota diária da API do Google, e o
 * arquivo ocupa espaço no bucket até a limpeza periódica. A tela de progresso
 * existe porque o round trip é longo e um cartão parado sem explicação parece
 * travado.
 */
export function DrivePickerPanel({ open, onClose, context }: Props) {
  const [busca, setBusca] = useState('');
  const [arquivos, setArquivos] = useState<DriveVideo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [copiando, setCopiando] = useState<string | null>(null);
  const [progresso, setProgresso] = useState(0);
  const [fase, setFase] = useState<'baixando' | 'enviando' | null>(null);

  const carregar = useCallback(async (termo: string) => {
    setCarregando(true);
    setErro(null);
    try {
      setArquivos(await listarVideosDrive(termo));
    } catch (e) {
      setArquivos([]);
      setErro(
        e instanceof Error && e.message === 'not_connected'
          ? 'Conecte a conta do Google Drive para ver os vídeos.'
          : 'Não foi possível listar os vídeos do Drive. Tente de novo.',
      );
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (open) void carregar(busca);
    // Só a abertura dispara: digitar não recarrega a lista a cada tecla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Timeout de 30s por requisição: o Drive pode demorar, mas não para sempre. */
  const comTimeout = <T,>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
    ]);

  const copiarParaASala = async (video: DriveVideo) => {
    setErro(null);
    setCopiando(video.id);
    setProgresso(0);
    try {
      // 1) O servidor confirma que o arquivo é um vídeo desta conta e devolve
      //    a URL e um access token de uma hora. O refresh token não sai de lá.
      setFase('baixando');
      const info = await comTimeout(pedirDownload(video.id));

      // 2) O navegador baixa do Drive direto. É o passo longo, e o progresso
      //    dele é o que impede o cartão de parecer travado.
      setProgresso(0);
      const resposta = await comTimeout(fetch(info.url, { headers: { Authorization: `Bearer ${info.token}` } }));
      if (!resposta.ok) throw new Error('download_failed');
      const total = Number(resposta.headers.get('content-length') ?? 0);
      const corpo = await (async () => {
        if (!resposta.body || !total) return await resposta.arrayBuffer();
        // `stream` no reader para ter progresso de verdade: ler o arrayBuffer
        // inteiro de uma vez não dá nenhum ponto intermediário.
        const leitor = resposta.body.getReader();
        const partes: Uint8Array[] = [];
        let recebido = 0;
        for (;;) {
          const { done, value } = await leitor.read();
          if (done) break;
          if (value) {
            partes.push(value);
            recebido += value.byteLength;
            if (total) setProgresso(Math.min(99, Math.round((recebido / total) * 100)));
          }
        }
        return new Blob(partes as BlobPart[]).arrayBuffer();
      })();
      const arquivo = new File([corpo], info.name, { type: info.mimeType });

      // 3) E sobe no bucket da sala, pelo mesmo caminho de sempre.
      setFase('enviando');
      setProgresso(0);
      const token = await context.requestUploadToken({
        fileName: info.name,
        fileSize: arquivo.size,
        mimeType: info.mimeType,
      });
      if (!token.ok) throw new Error(token.error);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', token.uploadUrl);
        xhr.setRequestHeader('Content-Type', token.contentType);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgresso(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error('upload_failed'));
        xhr.onerror = () => reject(new Error('upload_failed'));
        xhr.send(arquivo);
      });

      context.addToPlaylist({
        kind: 'file',
        src: token.publicUrl,
        title: info.name.replace(/\.[^./]+$/, '') || info.name,
        duration: info.durationMs ? Math.round(info.durationMs / 1000) : undefined,
      });
      onClose();
    } catch (e) {
      const motivo = e instanceof Error ? e.message : '';
      setErro(
        motivo === 'timeout'
          ? 'O Drive demorou demais para responder. Tente de novo.'
          : motivo === 'not_found'
            ? 'Esse vídeo não está mais disponível no seu Drive.'
            : motivo === 'not_connected'
              ? 'A conta do Drive foi desconectada. Conecte de novo.'
              : 'Não foi possível copiar o vídeo do Drive. Tente de novo.',
      );
      setCopiando(null);
      setFase(null);
    }
  };

  if (!open) return null;

  const rotulos = { baixando: 'Baixando do Drive', enviando: 'Enviando para a sala' };

  return (
    <Portal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Escolher vídeo do Google Drive"
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !copiando) onClose();
        }}
      >
        <div className="animate-fade-up flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-lift sm:rounded-2xl">
          <div className="flex items-center gap-2 border-b border-hairline p-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-hairline bg-raised px-3 focus-within:border-accent/60">
              <MagnifyingGlass size={16} className="shrink-0 text-ink-faint" />
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void carregar(busca);
                }}
                placeholder="Buscar por nome no Drive"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <Button size="sm" onClick={() => void carregar(busca)} disabled={carregando} className="h-7 shrink-0 px-2.5">
                Buscar
              </Button>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={Boolean(copiando)}
              aria-label="Fechar busca"
              className="shrink-0 rounded-md p-2 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
            {erro && (
              <p className="flex items-start gap-2 p-2 text-2xs leading-relaxed text-live/90">
                <WarningCircle size={14} className="mt-px shrink-0" />
                {erro}
              </p>
            )}

            {carregando && <p className="p-4 text-center text-2xs text-ink-faint">Procurando vídeos…</p>}

            {!carregando && !erro && arquivos.length === 0 && (
              <p className="p-4 text-center text-2xs leading-relaxed text-ink-faint">
                Nenhum vídeo encontrado no seu Drive.
                <br />
                O Drive só lista o que está em <span className="text-ink-muted">Meu Drive</span> — nada
                de “Compartilhados comigo”.
              </p>
            )}

            {arquivos.length > 0 && (
              <ul>
                {arquivos.map((v) => {
                  const ativo = copiando === v.id;
                  const tam = tamanhoLegivel(v.size);
                  const dur = duracaoLegivel(v.durationMs);
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => void copiarParaASala(v)}
                        disabled={Boolean(copiando)}
                        className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150 hover:bg-hover disabled:opacity-60"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-black/25 text-ink-faint">
                          {ativo ? (
                            <CloudArrowDown size={18} className="animate-pulse text-accent" />
                          ) : (
                            <FilmStrip size={18} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <TruncatedText
                            text={v.name}
                            lineClamp={2}
                            className="block text-[0.8125rem] leading-snug text-ink"
                          />
                          {ativo ? (
                            <span className="mt-1 block text-2xs text-accent">
                              {fase ? rotulos[fase] : 'Trabalhando'} — {progresso}%
                              <span className="mt-1 block h-1 overflow-hidden rounded-full bg-hover">
                                <span
                                  className="block h-full rounded-full bg-accent transition-[width] duration-200"
                                  style={{ width: `${progresso}%` }}
                                />
                              </span>
                            </span>
                          ) : (
                            <span className="block text-2xs text-ink-faint">
                              {[dur, tam].filter(Boolean).join(' · ') || v.mimeType}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="border-t border-hairline px-4 py-2.5 text-2xs leading-relaxed text-ink-faint">
            O vídeo é copiado para o bucket da sala, e não compartilhado. Só quem escolhe precisa de
            acesso ao Drive — todo mundo mais assiste de uma URL da sala.
          </p>
        </div>
      </div>
    </Portal>
  );
}
