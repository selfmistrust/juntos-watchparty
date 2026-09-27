/**
 * Monta o web dentro do `desktop` para empacotamento.
 *
 * Roda o `next build` da pasta `web` com `NEXT_STANDALONE=1`, que liga o
 * `output: 'standalone'` no `next.config.js`. Esse modo gera um servidor
 * autocontido — `server.js` mais um `node_modules` só com o que o Next
 * realmente usa — e é ele que o processo principal sobe.
 *
 * O que o modo standalone **não** copia, e este script copia: `.next/static` e
 * `public`. Sem eles a janela abre e fica sem CSS e sem JavaScript, o que
 * parece um app quebrado sem nenhuma pista de por quê.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..', '..');
const web = path.join(raiz, 'web');
const destino = path.join(raiz, 'desktop', 'web-standalone');

/**
 * Executa o npm chamando o CLI pelo node.
 *
 * Não dá para spawnar `npm` (ou `npm.cmd`) direto: desde o CVE-2024-27980 o
 * Node recusa `.cmd`/`.bat` sem shell, e `shell: true` voltaria com o aviso
 * DEP0190 de argumentos concatenados sem escape. Os argumentos aqui são
 * fixos, mas um script de empacotamento não é lugar para teachar o padrão.
 * O CLI do npm vem junto com o node, então o caminho é direto.
 */
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function rodar(args, cwd, env = {}) {
  if (!fs.existsSync(npmCli)) {
    console.error(`Não achei o CLI do npm em ${npmCli}`);
    process.exit(1);
  }
  console.log(`> npm ${args.join(' ')}  (em ${path.relative(raiz, cwd) || '.'})`);
  const r = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`\nFalhou: npm ${args.join(' ')} (código ${r.status ?? r.signal})`);
    if (r.error) console.error(r.error.message);
    process.exit(r.status ?? 1);
  }
}

function copiarSeExiste(de, para) {
  if (!fs.existsSync(de)) {
    console.log(`  (não existe, pulando) ${path.relative(raiz, de)}`);
    return;
  }
  fs.rmSync(para, { recursive: true, force: true });
  fs.cpSync(de, para, { recursive: true });
  console.log(`  ${path.relative(raiz, de)} -> ${path.relative(raiz, para)}`);
}

console.log('1/3  limpando builds anteriores');
fs.rmSync(destino, { recursive: true, force: true });

console.log('\n2/3  build do web (standalone)');
// NEXT_STANDALONE é o que liga o `output: 'standalone'` lá no next.config.js.
// Sem ele o build da Vercel seria afetado, e o `output` é o que define se o
// servidor local do app sequer existe.
//
// NEXT_PUBLIC_SERVER_URL é o endereço do servidor de salas que o app vai falar.
// Ele é embutido no bundle em build, então precisa vir no momento do build —
// não dá para ajustar depois. Sem ela, `lib/socket.ts` cai no default
// `http://localhost:4000`, que é o servidor de desenvolvimento.
//
// Dois modos, porque eles querem coisas opostas:
//
//   dev  (npm start)  -> falar com o servidor da sua máquina, para testar
//   prod (npm run dist) -> falar com o Render, porque o instalador vai para
//                          a casa de outra pessoa
//
// O modo prod existe por um motivo concreto: o Next também lê `web/.env.local`
// durante o build, e lá mora `http://localhost:4001` para uso local. Sem esta
// distinção, um `npm run dist` gerava um instalador de 94 MB que abria sem
// nunca achar servidor de sala — e o aviso passava batido num log de build.
const SERVIDOR_PROD = 'https://juntos-watchparty.onrender.com';
const prod = process.argv.includes('--prod');

let servidor = (process.env.NEXT_PUBLIC_SERVER_URL ?? '').trim();
const apontandoParaLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(servidor);

if (prod && (!servidor || apontandoParaLocal)) {
  if (servidor) {
    console.log(
      `\nNEXT_PUBLIC_SERVER_URL está como ${servidor}, que só existe na sua máquina.\n` +
        'Um instalador distribuído não acharia o servidor de salas: o app abriria\n' +
        'normal e nunca entraria em nenhuma sala. Vou usar ' +
        SERVIDOR_PROD +
        '.\n',
    );
  } else {
    console.log(`\nNEXT_PUBLIC_SERVER_URL não vem no ambiente; usando ${SERVIDOR_PROD}.`);
  }
  servidor = SERVIDOR_PROD;
} else if (!prod && !servidor) {
  console.warn(
    '\nAVISO: NEXT_PUBLIC_SERVER_URL não definida. O build vai ler web/.env.local\n' +
      'e o app apontará para o servidor de desenvolvimento. Para gerar o\n' +
      'instalador use "npm run dist", que fixa o servidor de produção.\n',
  );
}

rodar(['run', 'build'], web, {
  NEXT_STANDALONE: '1',
  ...(servidor ? { NEXT_PUBLIC_SERVER_URL: servidor } : {}),
});

// O build precisa ter saído com o output certo; sem esta checagem a falha
// apareceria só na hora de abrir o app, como tela branca.
const standalone = path.join(web, '.next', 'standalone');
if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error(
    '\nO build não gerou .next/standalone/server.js.\n' +
      'O `output: \'standalone\'` do next.config.js está condicionado a NEXT_STANDALONE=1 — ' +
      'confirme que essa variável está chegando no build (veja o spawn acima).',
  );
  process.exit(1);
}

console.log('\n3/3  copiando o servidor e os assets que o standalone não leva');

// O standalone inteiro primeiro: é ele que contém `server.js` e o
// `node_modules` enxuto com o Next. Sem esta cópia o diretório de destino
// fica só com os assets e o app sobe sem servidor nenhum.
copiarSeExiste(standalone, destino);

// E por cima os dois diretórios que o modo standalone não inclui, sem os quais
// a janela abre sem CSS e sem JavaScript.
const destinoNext = path.join(destino, '.next');
fs.mkdirSync(destinoNext, { recursive: true });
copiarSeExiste(path.join(web, '.next', 'static'), path.join(destinoNext, 'static'));
copiarSeExiste(path.join(web, 'public'), path.join(destino, 'public'));

// A pasta do próprio pacote não é fonte do app e não deve seguir para dentro
// do instalador.
fs.rmSync(path.join(destino, 'node_modules', 'electron'), { recursive: true, force: true });
fs.rmSync(path.join(destino, 'node_modules', 'electron-builder'), { recursive: true, force: true });

// Verificação final no destino, e não na origem: o que importa é o que o
// processo principal vai encontrar em `web-standalone/server.js`.
//
// Estes caminhos são os que o servidor do Next exige para subir. Sem esta
// checagem, uma cópia interrompida — que acontece quando o app está rodando e
// segura arquivos do diretório — gerava um pacote que instalava, abria, e
// morria com "Cannot find module '@next/env'". O aviso é sobre o
// `desktop/web-standalone`, e o sintoma só apareceria na máquina de quem
// instalasse.
const exigidos = [
  'server.js',
  'package.json',
  path.join('node_modules', 'next', 'package.json'),
  path.join('node_modules', '@next', 'env', 'package.json'),
  path.join('.next', 'static'),
];
const faltando = exigidos.filter((p) => !fs.existsSync(path.join(destino, p)));
if (faltando.length > 0) {
  console.error(
    '\nA cópia do servidor ficou incompleta. Faltou:\n' +
      faltando.map((p) => `  - ${p}`).join('\n') +
      '\n\nO app estiver aberto segura os arquivos deste diretório. Feche o ' +
      'Juntos e rode de novo.',
  );
  process.exit(1);
}

// Última checagem: o endereço do servidor de salas realmente embutido no
// bundle, lido do arquivo que o app vai executar.
//
// Confiar no aviso não funciona — o aviso sobre NEXT_PUBLIC_SERVER_URL passou
// batido e mesmo assim o instalador saiu apontando para localhost, porque o
// Next lê `web/.env.local` no build. Aqui a verificação é sobre o artefato, e
// não sobre a intenção: ou o host esperado está no bundle, ou o build está
// errado e o `electron-builder` não deve nem começar a empacotar 94 MB em
// volta disso.
if (servidor) {
  const host = servidor.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const pedacos = [];
  const colecionar = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entrada.isFile() && entrada.name.endsWith('.js')) pedacos.push(path.join(entrada.parentPath ?? entrada.path, entrada.name));
    }
  };
  colecionar(path.join(destino, '.next', 'static'));
  colecionar(path.join(destino, 'pages'));

  const achou = pedacos.some((p) => fs.readFileSync(p, 'utf8').includes(host));
  if (!achou) {
    console.error(
      `\nO bundle não referencia ${host}.\n` +
        `Varre ${pedacos.length} arquivo(s) em .next/static e pages e nada contém esse host.\n` +
        'O Next provavelmente leu web/.env.local e venceu a variável do ambiente.\n' +
        'Confira web/.env.local e rode de novo.',
    );
    process.exit(1);
  }
  console.log(`  bundle aponta para ${host} ( conferido em ${pedacos.length} arquivo(s) )`);
}

const tamanho = fs
  .readdirSync(destino, { recursive: true })
  .map((p) => path.join(destino, String(p)))
  .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
  .reduce((s, p) => s + fs.statSync(p).size, 0);

console.log(`\nPronto: ${path.relative(raiz, destino)} (${(tamanho / 1e6).toFixed(0)} MB)`);
