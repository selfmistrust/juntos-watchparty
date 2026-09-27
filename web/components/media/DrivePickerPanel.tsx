'use client';

import { useEffect, useRef, useState } from 'react';
import { FilmStrip, WarningCircle, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import { Portal } from '@/components/ui/Portal';
import { SourceAccountRow } from '@/components/media/SourceAccountRow';
import { fetchDrivePickerToken, requestDriveStream } from '@/lib/driveAccount';
import { escolherVideoNoGoogleDrive } from '@/lib/googlePicker';
import { escolherVideoNoNavegador } from '@/lib/driveBrowserPicker';
import { isDesktop } from '@/lib/desktop';
import { SERVER_URL } from '@/lib/socket';
import type { MediaSourceAccount, MediaSourceContext } from '@/lib/mediaSources';

interface Props {
  open: boolean;
  onClose: () => void;
  context: MediaSourceContext;
  account: MediaSourceAccount;
  refreshAccount: () => Promise<void>;
}

type Fase = 'picker' | 'navegador' | 'concedendo' | null;

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
  bad_file: 'Esse arquivo do Drive não tem um id válido.',
  not_a_video: 'Escolha um arquivo de vídeo.',
  no_download: 'O dono desse arquivo bloqueou o download. Escolha outro vídeo.',
  drive_unreachable: 'O Google Drive não respondeu. Tente de novo.',
  stream_failed: 'Não foi possível liberar esse vídeo para a sala. Tente de novo.',
};

/**
 * Escolhe um vídeo do Drive e o coloca na fila.
 *
 * ## Não há mais download aqui
 *
 * Este painel já baixava o arquivo inteiro do Drive e subia para o bucket antes
 * de a faixa existir. Para um episódio isso era duas transferências
 * sequenciais pela mesma conexão, e o pico de memória no navegador era de cerca
 * de duas vezes o tamanho do arquivo — 2,2 GB viravam alguns gigabytes de RAM.
 *
 * Agora a única coisa que acontece depois da escolha é um POST pedindo a
 * concessão de reprodução. O item entra na fila na hora, com um `src` que é a
 * rota de stream, e o `<video>` pede os bytes por partes. Por isso não existe
 * mais barra de progresso aqui: não há o que esperar.
 *
 * ## A autorização é de quem escolheu
 *
 * O token do Drive pertence à pessoa que selecionou o arquivo, e é ele que
 * serve o stream para todo mundo. Se essa pessoa desconectar ou revogar, a
 * faixa para de funcionar — é o preço de não copiar o vídeo para o bucket.
 */
export function DrivePickerPanel({ open, onClose, context, account, refreshAccount }: Props) {
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
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

  const escolherVideo = async () => {
    if (operacao.current) return;
    const controller = new AbortController();
    operacao.current = controller;
    const { signal } = controller;
    setErro(null);
    setOcupado(true);
    setFase('picker');
    try {
      let fileId: string | null;
      if (externo) {
        fileId = await escolherVideoNoNavegador(signal, () => setFase('navegador'));
        if (!signal.aborted) void refreshAccount();
      } else {
        // O prazo de rede não se aplica ao tempo que a pessoa leva para escolher.
        const pickerToken = await fetchDrivePickerToken(signal);
        fileId = await escolherVideoNoGoogleDrive(pickerToken, signal);
      }
      if (!fileId || signal.aborted) return;

      setFase('concedendo');
      const target = await requestDriveStream(fileId, signal);
      signal.throwIfAborted();
      context.addToPlaylist({
        kind: 'file',
        src: `${SERVER_URL}${target.path}`,
        title: target.name.replace(/\.[^./]+$/, '') || target.name,
        duration: target.duration,
      });
      onClose();
    } catch (e) {
      if (signal.aborted) return;
      const motivo = e instanceof Error ? e.message : '';
      if (motivo === 'not_connected') void refreshAccount();
      setErro(MENSAGENS_ERRO[motivo] ?? 'Não foi possível escolher esse vídeo do Drive.');
    } finally {
      controller.abort();
      if (operacao.current === controller) {
        operacao.current = null;
        setOcupado(false);
        setFase(null);
      }
    }
  };

  if (!open) return null;

  const rotulos: Record<Exclude<Fase, null>, string> = {
    picker: externo ? 'Abrindo navegador' : 'Abrindo Google Picker',
    navegador: 'Aguardando seleção no navegador',
    concedendo: 'Liberando o vídeo para a sala',
  };

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
              <FilmStrip size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-ink">Google Drive</h2>
              <p className="text-2xs leading-relaxed text-ink-faint">
                Selecione um vídeo; a sala começa a assistir na hora.
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
                <p role="status" className="text-sm text-ink">{rotulos[fase ?? 'picker']}</p>
                {fase === 'navegador' && (
                  <>
                    <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
                      Escolha o vídeo na aba do Google e volte para o Juntos. Se fechar a aba, cancele
                      esta seleção para tentar novamente.
                    </p>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => operacao.current?.abort()}>
                      Cancelar seleção
                    </Button>
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
            O vídeo é reproduzido direto do seu Drive, por partes, sem esperar o arquivo inteiro
            baixar. O app só acessa o arquivo escolhido no Picker — mas ele é lido pela conta que
            conectou, então desconectar essa conta interrompe a faixa.
          </p>
        </div>
      </div>
    </Portal>
  );
}
