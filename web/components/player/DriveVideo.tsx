'use client';

import { useCallback, useEffect, useRef, useState, forwardRef } from 'react';
import { FilmStrip, WarningCircle } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import { useDriveAccount } from '@/hooks/useDriveAccount';
import { fetchDrivePickerToken } from '@/lib/driveAccount';
import { publicarToken, registrarMediaWorker, temAcessoAoArquivo, urlDeMidia } from '@/lib/driveMedia';
import { autorizarArquivoDoGoogleDrive } from '@/lib/googlePicker';
import { isDesktop } from '@/lib/desktop';
import { useRouter } from 'next/router';
import type { PlayerHandle } from '@/types';
import { FilePlayer } from './FilePlayer';

/**
 * `falhou` é separado de `indisponivel` de propósito: `indisponivel` é uma
 * impossibilidade conhecida antes de tentar (sem service worker, o Picker não
 * configurado), e `falhou` é o `<video>` recusando a leitura depois que tudo
 * parecia estar certo. A pessoa precisa poder tentar de novo em um, e entender o
 * que houve no outro.
 */
type Estado = 'conferindo' | 'autorizar' | 'pronto' | 'falhou' | 'indisponivel';

interface Props {
  fileId: string;
  /** Fim de reprodução, para a fila avançar. */
  onEnded: () => void;
  onReady: () => void;
}

/**
 * Reproduz um arquivo do Drive direto com a conta de quem assiste.
 *
 * ## Nada de proxy
 *
 * O `src` é um caminho da própria origem, interceptado pelo service worker, que
 * troca pela URL do Google e acrescenta o token desta conta. O vídeo não passa
 * pelo Render nem pelo bucket, e o navegador continua pedindo intervalos — o
 * seek funciona igual a um arquivo comum.
 *
 * ## Por que existe o botão de autorizar
 *
 * O escopo `drive.file` dá acesso ao app só a arquivos que **esta** pessoa
 * escolheu. O Juntos já concedeu a permissão `reader` no arquivo para ela, mas o
 * vínculo com o app só nasce no Picker. O botão abre o seletor já filtrado
 * naquele arquivo, então é um clique, uma vez — e só isso separa a pessoa de
 * assistir.
 */
export const DriveVideo = forwardRef<PlayerHandle, Props>(function DriveVideo(
  { fileId, onEnded, onReady },
  ref,
) {
  const router = useRouter();
  const { status, loading: contaCarregando, busy: contaBusy, connect, refresh } = useDriveAccount();
  const [estado, setEstado] = useState<Estado>('conferindo');
  const [erro, setErro] = useState<string | null>(null);
  const [autorizando, setAutorizando] = useState(false);
  const operacao = useRef<AbortController | null>(null);
  const externo = isDesktop();

  /*
   * `drive=...` é o que o callback do OAuth deixa na URL quando a pessoa
   * conectou a conta no navegador do sistema. Sem esta leitura, o app desktop
   * ficaria mostrando "conecte o Drive" mesmo com a conta conectada, porque a
   * janela não é recarregada — ela só recebe o foco de novo.
   */
  const conectouNaVolta = router.query.drive === 'connected';

  const conferir = useCallback(async () => {
    const controller = new AbortController();
    operacao.current?.abort();
    operacao.current = controller;
    setErro(null);
    try {
      await registrarMediaWorker();
      if (!contaCarregando && !status.connected) {
        setEstado('autorizar');
        return;
      }
      if (!contaCarregando && !status.configured) {
        setEstado('indisponivel');
        return;
      }
      const token = await fetchDrivePickerToken(controller.signal);
      /*
       * O token precisa estar gravado no worker **antes** do `<video>` pedir o
       * primeiro intervalo, e a gravação é assíncrona. Sem esperar a
       * confirmação, o vídeo pede o primeiro bloco antes de o token existir e
       * leva 401 — que aparece como player preto em 0:00, sem mensagem.
       */
      const publicado = await publicarToken(token);
      if (!publicado) {
        setErro('Não foi possível preparar a leitura do Google neste navegador.');
        setEstado('indisponivel');
        return;
      }
      const temAcesso = await temAcessoAoArquivo(fileId, token, controller.signal);
      setEstado(temAcesso ? 'pronto' : 'autorizar');
    } catch (e) {
      if (controller.signal.aborted) return;
      const motivo = e instanceof Error ? e.message : '';
      if (motivo === 'not_connected') {
        void refresh();
        setEstado('autorizar');
      } else {
        setErro('Não foi possível falar com o Google Drive. Tente de novo.');
        setEstado('indisponivel');
      }
    }
  }, [contaCarregando, status.connected, status.configured, fileId, refresh]);

  useEffect(() => {
    if (contaCarregando) return;
    void conferir();
    return () => operacao.current?.abort();
  }, [conferir, contaCarregando, conectouNaVolta]);

  const autorizar = useCallback(async () => {
    if (autorizando) return;
    setAutorizando(true);
    setErro(null);
    const controller = new AbortController();
    try {
      const token = await fetchDrivePickerToken(controller.signal);
      const ok = await autorizarArquivoDoGoogleDrive(token, fileId, controller.signal);
      if (controller.signal.aborted) return;
      if (!ok) return; // cancelar não é erro: a pessoa decide quando quer.
      await conferir();
    } catch (e) {
      if (controller.signal.aborted) return;
      const motivo = e instanceof Error ? e.message : '';
      setErro(
        motivo === 'picker_not_configured'
          ? 'O Google Picker ainda não está configurado para este app.'
          : motivo === 'browser_open_failed'
            ? 'Não foi possível abrir o navegador. Tente de novo.'
            : 'Não foi possível abrir o seletor do Google. Tente de novo.',
      );
    } finally {
      setAutorizando(false);
    }
  }, [autorizando, fileId, conferir]);

  if (estado === 'pronto') {
    return (
      <FilePlayer
        ref={ref}
        src={urlDeMidia(fileId)}
        onReady={onReady}
        onEnded={onEnded}
        /*
         * O erro do `<video>` é o único sinal de que algo deu errado depois da
         * checagem de acesso — que só prova que a *conta* pode ler o arquivo,
         * não que o worker conseguiu entregá-lo. Converter o erro em estado é o
         * que troca "player preto em 0:00" por algo que a pessoa entende.
         */
        onError={(motivo) => {
          setErro(motivo);
          setEstado('falhou');
        }}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-black/25 text-ink-faint">
        <FilmStrip size={20} />
      </span>

      {estado === 'conferindo' ? (
        <p role="status" className="text-2xs text-ink-faint">Conferindo seu acesso ao vídeo…</p>
      ) : estado === 'falhou' ? (
        <>
          <p className="max-w-sm text-sm text-ink">A leitura deste vídeo falhou.</p>
          {erro && <p className="max-w-sm text-2xs text-ink-faint">{erro}</p>}
          <Button size="sm" onClick={() => void conferir()}>
            Tentar de novo
          </Button>
        </>
      ) : estado === 'indisponivel' ? (
        <>
          <p className="max-w-sm text-sm text-ink">Não foi possível reproduzir este vídeo do Drive.</p>
          {erro && <p className="text-2xs text-live/90">{erro}</p>}
          <Button variant="outline" size="sm" onClick={() => void conferir()}>
            Tentar de novo
          </Button>
        </>
      ) : (
        <>
          <p className="max-w-sm text-sm text-ink">
            {status.connected
              ? 'Autorize o app neste vídeo para assistir. É só confirmar uma vez.'
              : 'Conecte sua conta do Google Drive para assistir a este vídeo.'}
          </p>
          {erro && <p className="text-2xs text-live/90">{erro}</p>}
          {status.connected ? (
            <Button size="sm" onClick={() => void autorizar()} disabled={autorizando}>
              {autorizando ? 'Abrindo o seletor…' : 'Autorizar este vídeo'}
            </Button>
          ) : (
            <Button size="sm" onClick={connect} disabled={contaBusy}>
              {contaBusy ? 'Conectando…' : 'Conectar o Google Drive'}
            </Button>
          )}
        </>
      )}

      <p className="mt-1 flex items-start gap-1.5 text-2xs leading-relaxed text-ink-faint">
        <WarningCircle size={13} className="mt-px shrink-0" />
        O vídeo é lido direto do Google pela sua conta, sem passar pelo servidor do Juntos.
        {externo && ' No app desktop, o seletor abre no navegador do sistema.'}
      </p>
    </div>
  );
});