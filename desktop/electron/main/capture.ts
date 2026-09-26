import { desktopCapturer, session } from 'electron';
import type { CaptureErrorReason, CaptureSource } from '../shared/contract';

/**
 * Estado da captura. Vive no processo principal porque é ele quem decide qual
 * fonte o `getDisplayMedia` do renderer vai receber — o renderer nunca escolhe,
 * só recebe o `MediaStream` já autorizado.
 */
let capturando = false;
let idAtivo: string | null = null;

/**
 * Cópia das fontes descobertas na última listagem.
 *
 * O handler precisa de `{ id, name }` da fonte escolhida, e o `idAtivo` chega
 * do renderer como texto puro. Guardar a lista aqui é o que valida esse id de
 * verdade: um id forjado pelo renderer não encontra nada em `ativas` e a
 * captura é recusada.
 */
let ativas: CaptureSource[] = [];

/**
 * O seletor é o da **nossa** UI, não o do sistema: `useSystemPicker: false`.
 *
 * O seletor nativo do Windows até funciona, mas ele é uma janela do SO com
 * vida própria, e a entrega pedida era a captura integrada no app, com a
 * pré-visualização ao lado do resto. Deixar o SO escolher também tiraria do
 * renderer a chance de mostrar o que está sendo transmitido antes de confirmar.
 */

/** Cache curto das miniaturas: o seletor reabre várias vezes na mesma sessão. */
let cache: { fontes: CaptureSource[]; emMs: number } | null = null;
const CACHE_MS = 2_000;

export async function listarFontes(forcar = false): Promise<CaptureSource[]> {
  if (!forcar && cache && Date.now() - cache.emMs < CACHE_MS) return cache.fontes;

  const brutas = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    // Sem isto entra na lista a "Captura de Tela" do Windows, que é um
    // atalho para o seletor do próprio SO e falha ao iniciar por aqui.
    fetchWindowIcons: false,
  });

  const fontes: CaptureSource[] = await Promise.all(
    brutas.map(async (f) => ({
      id: f.id,
      name: f.name,
      kind: f.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: f.thumbnail.toDataURL(),
    })),
  );

  ativas = fontes;
  cache = { fontes, emMs: Date.now() };
  return fontes;
}

/**
 * Instala o handler que responde ao `getDisplayMedia` do renderer.
 *
 * É este o ponto que um navegador não deixa alcançar. O `audio: 'loopback'`
 * pede **o áudio do sistema inteiro**, e a documentação do Electron é
 * explícita: só funciona no Windows. Nenhum navegador web expõe isso — o
 * Chrome oferece apenas o microfone, e o Firefox ainda menos. Por isso o app
 * tem alvo Windows.
 *
 * O `video` é só `{ id, name }` da fonte escolhida: o Electron monta o
 * `MediaStream` e entrega ao `getDisplayMedia` do renderer, que é quem o
 * recebe. Não há `getUserMedia` aqui, e não é preciso.
 */
export function instalarHandlerDeCaptura(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const fonte = ativas.find((f) => f.id === idAtivo);

      if (!fonte) {
        // O renderer pediu captura sem passar pela UI. Não é caminho que o app
        // usa, e sem `id` o Chromium cairia no seletor dele — que aqui não
        // existe, porque `useSystemPicker` está desligado.
        callback({});
        return;
      }

      capturando = true;
      callback({
        video: { id: fonte.id, name: fonte.name },
        // `loopbackWithMute` em vez de `loopback`: sem isso o áudio capturado
        // volta para as caixas de som da máquina e a pessoa ouve um eco do que
        // está transmitindo.
        audio: 'loopbackWithMute',
      });
    },
    { useSystemPicker: false },
  );
}

/** Define qual fonte o próximo `getDisplayMedia` vai receber. */
export function escolherFonte(id: string | null): void {
  idAtivo = id;
  capturando = id !== null;
}

export function estaCapturando(): boolean {
  return capturando;
}

export function marcarParada(): void {
  capturando = false;
  idAtivo = null;
  cache = null;
}

const MENSAGENS: Record<CaptureErrorReason, string> = {
  cancelled: 'Você cancelou a escolha de tela.',
  denied: 'O Windows negou a permissão de captura de tela.',
  unsupported: 'Este sistema não permite captura de tela pelo app.',
  failed: 'Não foi possível iniciar a captura.',
};

export function erroDe(razao: CaptureErrorReason, mensagem?: string) {
  return { reason: razao, message: mensagem ?? MENSAGENS[razao] };
}
