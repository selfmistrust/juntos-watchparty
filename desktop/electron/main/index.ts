import { app, BrowserWindow, ipcMain, shell, session } from 'electron';
import path from 'node:path';
import { APP_ORIGIN, startLocalServer, type LocalServer } from './localServer';
import { iniciarLog, log } from './log';
import type { CaptureErrorReason } from '../shared/contract';
import {
  erroDe,
  escolherFonte,
  estaCapturando,
  instalarHandlerDeCaptura,
  listarFontes,
  marcarParada,
} from './capture';

/**
 * User-Agent de Chrome puro.
 *
 * O Electron announce `Electron/<versão>` no UA, e o YouTube recusa tocar
 * vídeo em contexts que se identificam assim — o player fica preto, que é
 * exatamente o bloqueio de iframe que a versão desktop veio para contornar.
 * Apresentar o mesmo UA do Chrome que a pessoa já tem resolve.
 *
 * O número de versão é o do Chromium embutido no Electron, e não o do Chrome do
 * sistema: é o que o motor realmente suporta, e um UA mais novo que o motor faz
 * ativar caminho de código que o Electron ainda não tem.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let janela: BrowserWindow | null = null;
let servidor: LocalServer | null = null;

/** A app web não deve saber de onde veio a URL; este é o único lugar que sabe. */
function configuracoesDaJanela(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 520,
    backgroundColor: '#08080A',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Necessário para o `getDisplayMedia` não ser bloqueado por política de
      // permissão, e para o `<iframe>` do YouTube carregar.
      plugins: true,
    },
  };
}

function criarJanela(): BrowserWindow {
  const w = new BrowserWindow(configuracoesDaJanela());

  w.once('ready-to-show', () => w.show());
  w.on('closed', () => {
    janela = null;
  });

  // Navegação para fora do app vai no navegador do sistema, nunca dentro da
  // janela: senão um link de convite ou os Termos substitutions a app e o
  // usuário fica preso sem barra de endereço.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (evento, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      evento.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  return w;
}

function registrarIpc(): void {
  ipcMain.handle('desktop:listar-fontes', (_e, forcar: boolean) => listarFontes(forcar === true));

  ipcMain.handle('desktop:escolher-fonte', (_e, id: string) => {
    escolherFonte(typeof id === 'string' && id ? id : null);
    return true;
  });

  ipcMain.handle('desktop:parar-captura', () => {
    marcarParada();
    return true;
  });

  ipcMain.handle('desktop:esta-capturando', () => estaCapturando());

  ipcMain.handle('desktop:erro-de', (_e, razao: string, mensagem?: string) =>
    erroDe(razao as CaptureErrorReason, typeof mensagem === 'string' ? mensagem : undefined),
  );

  ipcMain.handle('desktop:versao', () => app.getVersion());
}

/**
 * Filtro de permissões.
 *
 * O padrão do Electron é negar tudo que não for pedido explicitamente, e o
 * `getDisplayMedia` é uma permissão que o renderer pede — sem esta liberação
 * ele é recusado antes de chegar ao handler, e a captura não funciona nem com a
 * UI perfeita.
 *
 * `media` continua passando pelo pedido normal do Chromium, então o microfone
 * ainda exige a caixa de diálogo do sistema. `fullscreen` é liberado porque a
 * tela cheia do player precisa dele.
 */
const PERMISSOES_LIBERADAS = new Set(['display-capture', 'media', 'fullscreen']);

async function subir(): Promise<void> {
  const sessao = session.defaultSession;

  sessao.setUserAgent(USER_AGENT);
  sessao.setPermissionRequestHandler((_wc, p, cb) => cb(PERMISSOES_LIBERADAS.has(p)));

  // Autoplay sem gesto: o vídeo da fila tem que começar junto para todo mundo.
  // No navegador isso é bloqueado e o app inteiro perde o sentido; aqui o
  // app é desktop e a pessoa já o abriu de propósito.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  // Some com a tarja de "Electron insecure" em conteúdo misto. A app é
  // HTTP local servindo recursos locais, e o resto do conteúdo é HTTPS — não
  // há para onde o mixed-content estaria indo.
  app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests');

  instalarHandlerDeCaptura();
  registrarIpc();

  try {
    log(`subindo o servidor local em ${APP_ORIGIN}`);
    servidor = await startLocalServer(false, (linha) => {
      if (linha) log(`[next] ${linha}`);
    });
    log('servidor local pronto');
  } catch (err) {
    log('falha ao subir o servidor local', err);
    // Sem servidor local não há app: é melhor uma janela explicando do que uma
    // tela branca.
    janela = new BrowserWindow({
      ...configuracoesDaJanela(),
      width: 640,
      height: 420,
    });
    await janela.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="background:#08080A;color:#ECECEF;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
           <div style="max-width:34rem;padding:2rem">
             <h1 style="font-size:1.25rem;margin:0 0 .75rem">O app não conseguiu iniciar</h1>
             <p style="color:#9B9BA6;line-height:1.6;margin:0">${String(err)}</p>
           </div>
         </body>`,
      )}`,
    );
    return;
  }

  janela = criarJanela();
  await janela.loadURL(APP_ORIGIN);
  log(`janela carregou ${APP_ORIGIN}`);
}

// O log abre antes de qualquer decisão, inclusive antes do lock de instância
// única: se o app sair por causa do lock, é exatamente o caso em que a pessoa
// precisa de um arquivo para dizer que o app "não abriu".
iniciarLog();

// Uma instância só. Duas janelas apontando para a mesma sala local do Redis
// duplicariam o áudio e o estado de reprodução na mesma conta.
const unica = app.requestSingleInstanceLock();
log(unica ? 'instance única garantida' : 'outra instância já está rodando');

if (!unica) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (janela) {
      if (janela.isMinimized()) janela.restore();
      janela.focus();
    }
  });

  app.whenReady().then(subir).catch((err) => {
    log('falha ao subir', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    void servidor?.stop();
    app.quit();
  });

  // O macOS exige tratar o reativar; no Windows não muda nada.
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) {
      janela = criarJanela();
      void janela.loadURL(APP_ORIGIN);
    }
  });
}
