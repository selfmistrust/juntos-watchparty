import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Log em arquivo.
 *
 * Não é conveniência: quem abre o app não tem console, e uma falha no
 * processo principal (o servidor interno não sobe, a captura é negada) é
 * invisível sem isto. O arquivo fica em `%APPDATA%/Juntos/desktop.log`, que é
 * o lugar que o suporte deveria mandar a pessoa olhar primeiro.
 *
 * Também substitui o `console.log` do main: no Windows, o Electron não tem
 * console próprio, e a saída some quando o app é iniciado pelo Explorer.
 */
let arquivo: string | null = null;

/**
 * Onde o log mora.
 *
 * `userData` vem do `productName` do `package.json`, e não do `name` — sem
 * isso, rodando solto durante o desenvolvimento a pasta seria
 * `juntos-desktop` e, depois de empacotado, `Juntos`, e o log apareceria em
 * dois lugares diferentes. Com o `productName` declarado, o caminho é o mesmo
 * nos dois casos: `%APPDATA%\Juntos\logs`.
 */
function iniciar(): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    // Um arquivo por dia: um log único que cresce sem limite é o próprio
    // problema que o app desktop vem evitar.
    const dia = new Date().toISOString().slice(0, 10);
    arquivo = path.join(dir, `desktop-${dia}.log`);
    log(`log em ${arquivo}`);
  } catch {
    arquivo = null;
  }
}

export function log(...partes: unknown[]): void {
  const linha = `[${new Date().toISOString()}] ${partes
    .map((p) => (typeof p === 'string' ? p : inspect(p)))
    .join(' ')}\n`;
  if (arquivo) {
    try {
      fs.appendFileSync(arquivo, linha);
    } catch {
      // Disco cheio ou arquivo bloqueado: perder o log é melhor do que travar
      // o app por causa dele.
    }
  }
  // Também no stdout, para o `npm start` mostrar.
  process.stdout.write(linha);
}

function inspect(valor: unknown): string {
  if (valor instanceof Error) return `${valor.name}: ${valor.message}`;
  try {
    return JSON.stringify(valor);
  } catch {
    return String(valor);
  }
}

export function iniciarLog(): void {
  iniciar();
  /*
   * O runtime na primeira linha do arquivo.
   *
   * `chromium` vem de `process.versions.chrome`, e não de uma constante escrita à
   * mão: é o número que o motor realmente é, e é o que decide se um CDM do Widevine
   * aceito por este build é o do motor que está rodando. Uma versão escrita à mão aqui
   * seria uma segunda fonte, que diverge sem avisar — a mesma falha do `version` que o
   * `package.json` do app já teve uma vez.
   *
   * E o build empacotado é `Juntos.exe`, não `electron.exe`: o nome do executável
   * também muda o comportamento do VMP, e um log que não mostra qual dos dois estava
   * rodando não serve para diagnosticar isso.
   */
  log(`Juntos ${app.getVersion()} iniciando · node ${process.versions.node} · electron ${process.versions.electron} · chromium ${process.versions.chrome} · ${process.platform}${app.isPackaged ? ' · empacotado' : ' · desenvolvimento'}`);
}
