import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import { createServer } from 'node:net';
import path from 'node:path';

/**
 * Porta do servidor local.
 *
 * Fixa de propósito, e é o detalhe que faz a app funcionar. O renderer carrega
 * de `http://localhost:3210`, então essa origem precisa estar liberada no
 * `CLIENT_ORIGIN` do servidor de salas — e o Render não aceita coringa, só
 * lista de origens. Com porta aleatória seria impossível declarar isso lá.
 *
 * Antes de mudar o valor, Some `http://localhost:<porta>` do `CLIENT_ORIGIN`
 * no Render.
 */
export const APP_PORT = 3210;
export const APP_ORIGIN = `http://localhost:${APP_PORT}`;

/**
 * Onde está o `server.js` do Next.
 *
 * Empacotado, ele vive em `resources/web-standalone`, copiado pelo
 * `extraResources` do electron-builder — fora do asar de propósito, porque Node
 * não faz `require` de dentro de um. Rodando solto, fica ao lado do `dist`.
 */
const SERVER_JS = app.isPackaged
  ? path.join(process.resourcesPath, 'web-standalone', 'server.js')
  : path.join(__dirname, '..', '..', 'web-standalone', 'server.js');

/**
 * Quanto esperar o Next subir antes de desistir.
 *
 * O primeiro boot é o mais lento: o Next lê as páginas, monta o router e só
 * então aceita conexão. 45s é folgado para spinner e curto o bastante para
 * não travar o app num limbo caso o servidor.js falhe de verdade — nesse caso
 * o processo morre e o `onExit` abaixo resolve antes do timeout.
 */
const BOOT_TIMEOUT_MS = 45_000;
const PROBE_INTERVAL_MS = 250;

export interface LocalServer {
  stop: () => Promise<void>;
}

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A porta está livre?
 *
 * O teste é **tentar ocupar**: se o `bind` der certo, ninguém está usando a
 * porta e ela está livre. Se der `EADDRINUSE`, está ocupada.
 *
 * O caminho oposto seria conectar na porta, mas isso responde "existe algo
 * escutando" e não "está livre" — que é a informação oposta, e foi
 * exatamente o bug da primeira versão: a sonda retornava `true` quando
 * conseguia ocupar, e o app se recusava a subir com a porta vazia.
 */
function portaLivre(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => socket.close(() => resolve(true)))
      .listen(port, host);
  });
}

/**
 * Sobe o servidor Next standalone e resolve quando ele aceita conexão.
 *
 * `HOSTNAME=127.0.0.1` e não `0.0.0.0`: o servidor do app não tem por que
 * responder na rede local. Ouvir em todas as interfaces abriria o servidor de
 * salas para qualquer pessoa na mesma rede Wi-Fi, sem nenhum aviso.
 */
export async function startLocalServer(
  dev = false,
  onLog: (line: string) => void = () => {},
): Promise<LocalServer> {
  // Uma instância anterior do app pode ter deixado a porta ocupada; sem este
  // check o processo novo sai com EADDRINUSE e a pessoa só vê um app quebrado.
  if (!(await portaLivre(APP_PORT, '127.0.0.1'))) {
    throw new Error(
      `A porta ${APP_PORT} já está em uso. Feche o Juntos que estiver aberto ` +
        `e tente de novo — se não for o app, o processo é outro.`,
    );
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [SERVER_JS],
    {
      env: {
        ...process.env,
        // **O ponto que faz o app empacotado funcionar.** `process.execPath`
        // dentro de um app Electron empacotado é o próprio `Juntos.exe`, não o
        // Node. Sem esta variável, o spawn rodava um *segundo Electron* com o
        // `server.js` de argumento: ele batia no lock de instância única, era
        // derrubado, e o app abria uma tela de erro dizendo que outra
        // instância já estava rodando. Com ela, o mesmo binário roda como Node
        // puro, e o servidor sobe.
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: String(APP_PORT),
        HOSTNAME: '127.0.0.1',
        // O Next standalone se apresenta como servidor de produção; sem isto ele
        // tenta abrir um watchdog de dev que não existe no pacote.
        NEXT_TELEMETRY_DISABLED: '1',
        ...(dev ? { NEXT_DEV: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  child.stdout?.on('data', (b) => onLog(String(b).trimEnd()));
  child.stderr?.on('data', (b) => onLog(String(b).trimEnd()));

  let exited = false;
  let exitInfo = '';
  child.once('exit', (code) => {
    exited = true;
    exitInfo = `código ${code}`;
  });

  const inicio = Date.now();
  while (Date.now() - inicio < BOOT_TIMEOUT_MS) {
    if (exited) {
      throw new Error(`O servidor interno do app parou de funcionar (${exitInfo}).`);
    }
    // A porta deixou de estar livre: o Next tomou ela e está no ar.
    if (!(await portaLivre(APP_PORT, '127.0.0.1'))) {
      return {
        stop: async () => {
          if (exited) return;
          child.kill();
          // Dá um instante para o Next fechar a porta antes de o app sair; sem
          // isso o próximo launch pode bater no EADDRINUSE do check acima.
          await wait(300);
        },
      };
    }
    await wait(PROBE_INTERVAL_MS);
  }

  child.kill();
  throw new Error(
    `O servidor interno do app não respondeu em ${Math.round(BOOT_TIMEOUT_MS / 1000)}s.`,
  );
}
