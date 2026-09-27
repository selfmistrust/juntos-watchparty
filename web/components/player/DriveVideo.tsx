'use client';

import { useCallback, useEffect, useRef, useState, forwardRef } from 'react';
import { FilmStrip, WarningCircle } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';
import { useDriveAccount } from '@/hooks/useDriveAccount';
import { fetchDrivePickerToken } from '@/lib/driveAccount';
import {
  explicarFalha,
  explicarPublicacao,
  lerFalhaDoWorker,
  publicarToken,
  temAcessoAoArquivo,
  urlDeMidia,
} from '@/lib/driveMedia';
import { autorizarArquivoDoGoogleDrive } from '@/lib/googlePicker';
import { isDesktop } from '@/lib/desktop';
import { useRouter } from 'next/router';
import type { PlayerHandle } from '@/types';
import { FilePlayer } from './FilePlayer';

/**
 * Os estados da preparação, na ordem em que acontecem.
 *
 * A separação importa porque cada um tem uma duração diferente e um motivo
 * diferente de estar parado. Um único "carregando…" esconde justamente o que a
 * pessoa precisa saber: se está faltando conta, se o navegador recusou o
 * service worker, ou se o vídeo já está pronto e o que falta é a sala alcançá-lo.
 *
 * `falhou` continua separado de `indisponivel` por outro motivo: o primeiro é o
 * `<video>` recusando a leitura depois que tudo parecia certo, e o segundo é uma
 * impossibilidade conhecida antes de tentar. Recomeçar resolve um, e não o outro.
 */
type Estado =
  /** Só começou; ainda não perguntou nada à rede. */
  | 'iniciando'
  /** Conferindo conta e permissão do arquivo. */
  | 'conferindo'
  /** Worker assumindo a página — o passo que trava mais. */
  | 'preparando'
  /** Player montado, aguardando metadados do Google. */
  | 'carregando'
  /** Pronto; falta alinhar com a posição da sala. */
  | 'sincronizando'
  | 'pronto'
  | 'autorizar'
  | 'falhou'
  | 'indisponivel';

/** O que a pessoa lê em cada etapa, e por que está esperando. */
const ROTULOS: Record<string, string> = {
  iniciando: 'Preparando o Google Drive…',
  conferindo: 'Conferindo seu acesso ao vídeo…',
  preparando: 'Conectando ao Google Drive…',
  carregando: 'Preparando vídeo…',
  sincronizando: 'Sincronizando com a sala…',
};

interface Props {
  fileId: string;
  /** Fim de reprodução, para a fila avançar. */
  onEnded: () => void;
  onReady: () => void;
  /**
   * Avisa que há um `<video>` montado, e não um painel de preparação.
   *
   * O `VideoStage` usa isso para decidir se o click-catcher de play/pause cobre
   * o palco. Enquanto o painel está na tela — conectando a conta, autorizando o
   * arquivo, esperando o Google — o catcher ficaria por cima dos botões e eles
   * pareceriam ativos sem receber o clique.
   *
   * `true` desde o primeiro frame com `<video>` na árvore, e não só quando o
   * vídeo carregou: o que importa é existir algo para o catcher alternar, e um
   * player ainda sem metadados já é isso.
   */
  onMediaPronta?: (pronta: boolean) => void;
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
  { fileId, onEnded, onReady, onMediaPronta },
  ref,
) {
  const router = useRouter();
  const { status, loading: contaCarregando, busy: contaBusy, connect, refresh } = useDriveAccount();
  // Começa em `iniciando`, e não em `conferindo`: entre o primeiro render e a
  // primeira chamada à rede há um instante, e um rótulo que já diz "conferindo"
  // sem estar conferindo é uma informação falsa muito cedo.
  const [estado, setEstado] = useState<Estado>('iniciando');
  const [erro, setErro] = useState<string | null>(null);
  const [autorizando, setAutorizando] = useState(false);
  const operacao = useRef<AbortController | null>(null);
  const externo = isDesktop();

  /*
   * O relatório para o palco sai de um `useEffect`, e não de dentro dos
   * `setEstado`.
   *
   * Chamar `onMediaPronta` durante o render warnings: o pai atualizaria o estado
   * enquanto este componente ainda está renderizando. O efeito roda depois, e
   * depende só do booleano — então trocar de painel para player avisa uma vez, e
   * desmontar avisa de novo para o catcher não ficar sobre o palco vazio.
   */
  const temPlayer = estado === 'carregando' || estado === 'sincronizando' || estado === 'pronto';
  useEffect(() => {
    onMediaPronta?.(temPlayer);
  }, [temPlayer, onMediaPronta]);

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
      /*
       * O registro do worker fica em um lugar só, dentro de `publicarToken`.
       * Aqui ele rodava também, e cada chamada refazia `register()` e imprimia o
       * próprio log — daí `[drive] registration criada` aparecer duas vezes. A
       * ordem importa: sem worker controlando a página, o `<video>` nem deve
       * ser montado, e é a publicação que garante isso.
       */
      if (!contaCarregando && !status.connected) {
        setEstado('autorizar');
        return;
      }
      if (!contaCarregando && !status.configured) {
        setEstado('indisponivel');
        return;
      }
      setEstado('conferindo');
      const token = await fetchDrivePickerToken(controller.signal);
      /*
       * Este é o passo que trava: o worker precisa assumir a página, e ele só
       * faz isso depois de um `activate` que pode demorar. Dizer "conectando ao
       * Google Drive" aqui é mais honesto do que um "carregando" genérico,
       * porque a pessoa sabe que a espera é do navegador, não da rede do Drive.
       */
      setEstado('preparando');
      /*
       * O token precisa estar gravado no worker **antes** do `<video>` pedir o
       * primeiro intervalo, e a gravação é assíncrona. Sem esperar a
       * confirmação, o vídeo pede o primeiro bloco antes de o token existir e
       * leva 401 — que aparece como player preto em 0:00, sem mensagem.
       */
      const publicado = await publicarToken(token);
      if (!publicado.ok) {
        // O motivo importa: recarregar a página resolve `sem_controle`, que é
        // o caso comum depois de um deploy, e não resolve nada em
        // `sem_suporte`. Uma frase única para os dois manda a pessoa fazer a
        // coisa errada.
        setErro(explicarPublicacao(publicado.motivo));
        setEstado('indisponivel');
        return;
      }
      const temAcesso = await temAcessoAoArquivo(fileId, token, controller.signal);
      if (!temAcesso) {
        setEstado('autorizar');
        return;
      }
      /*
       * A partir daqui o `<video>` é montado e o navegador busca os metadados no
       * Google. A espera é dele, e o rótulo muda porque a pessoa já não tem nada
       * a fazer: só esperar o primeiro bloco.
       */
      setEstado('carregando');
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

  /*
   * O `MediaError` sozinho não diz nada de útil: no Chromium um 401 do Google e
   * um arquivo num formato que o navegador não decodifica dão o mesmo código, e
   * o conserto é oposto — um é reconectar, o outro é escolher outro vídeo. O
   * worker registrou o que o Google respondeu, e é ele que vira a frase.
   */
  const falhar = useCallback((fallback: string) => {
    void lerFalhaDoWorker().then((falha) => {
      setErro(explicarFalha(falha, fallback));
      setEstado('falhou');
    });
  }, []);

  /*
   * Um único caminho de player, para `carregando`, `sincronizando` e `pronto`.
   *
   * Ramificar por estado aqui criaria dois `<FilePlayer>` com o mesmo `src`, e o
   * React veria um elemento diferente em cada transição — desmontando e
   * remontando o vídeo, o que joga o buffer fora e recomeça do zero. É
   * exatamente o que estraga quem entra no meio do filme: ele perde a posição
   * que a sala alcança.
   */
  if (temPlayer) {
    return (
      <FilePlayer
        ref={ref}
        src={urlDeMidia(fileId)}
        rotulo="drive"
        onReady={() => {
          setEstado('pronto');
          onReady();
        }}
        onEnded={onEnded}
        onError={falhar}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-black/25 text-ink-faint">
        <FilmStrip size={20} />
      </span>

      {estado === 'iniciando' || estado === 'conferindo' || estado === 'preparando' ? (
        // `aria-live` para o leitor de tela: quem não enxerga a mudança de estado
        // fica sem nenhuma pista de que algo está acontecendo.
        <p role="status" aria-live="polite" className="text-2xs text-ink-faint">
          {ROTULOS[estado] ?? ROTULOS.iniciando}
        </p>
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