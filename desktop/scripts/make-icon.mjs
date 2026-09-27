/**
 * Gera os ícones que o Windows exige, a partir do PNG oficial que já está no
 * `web/public`.
 *
 * ## Por que não dá para usar o `favicon.ico`
 *
 * O `favicon.ico` do projeto tem 48x48 — um único tamanho. Ícone de executável
 * no Windows é outra coisa: o shell pede o recurso de 256x256 para telas de
 * alta densidade e os menores para a barra de tarefas, o Alt+Tab e a
 * listagem de arquivos. Um `.ico` só com 48x48 sai borrado em quase todo
 * lugar, e o aviso do shell sobre "usar um ícone melhor" é o sintoma.
 *
 * ## Por que o `.ico` é gerado aqui e não deixado para o electron-builder
 *
 * O electron-builder converteria um PNG 512x512 em `.ico` sozinho, mas só para
 * o executável. A janela do Electron precisa de um arquivo em disco para o
 * `BrowserWindow`, e esse arquivo precisa existir **antes** do primeiro
 * `BrowserWindow` — inclusive no build de desenvolvimento, onde o
 * electron-builder nem participa. Gerando uma vez e versionando o resultado,
 * os dois lugares usam exatamente o mesmo ícone, e o `win.icon` aponta para um
 * arquivo que dá para inspecionar.
 *
 * ## O formato
 *
 * Um `.ico` é um diretório de imagens: 6 bytes de cabeçalho, 16 bytes por
 * entrada, e os PNGs em sequência. As entradas aqui são PNG comprimido, que o
 * Windows Vista+ lê em qualquer tamanho — o alvo do app já é Windows 10+ (o
 * Electron 33 exige Windows 10 22H2), então não há ganho em pagar o custo de
 * codificar as entradas pequenas como BMP, que é o formato legado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..', '..');

const fonte = path.join(raiz, 'web', 'public', 'android-chrome-512x512.png');
const saida = path.join(raiz, 'desktop', 'build');

/**
 * O sharp mora no `web/node_modules` (o Next traz para otimizar imagem) e não no
 * `desktop`, que não quer carregar uma dependência nativa só para gerar um
 * arquivo que já está versionado. O `require` sai de `web/package.json` para
 * achar o `node_modules` certo em vez de confiar no do `desktop`.
 */
const sharp = createRequire(path.join(raiz, 'web', 'package.json'))('sharp');

/** Todo tamanho que o Windows procura, do mais pequeno ao maior. */
const TAMANHOS = [16, 24, 32, 48, 64, 128, 256];

/**
 * Monta o contêiner ICO.
 *
 * A largura e a altura de cada entrada são um byte, e o valor 256 não cabe:
 * quem tem 256 grava 0. É uma peculiaridade do formato, não um erro aqui — por
 * isso a comparação em vez de uma atribuição direta.
 */
function montarIco(entradas) {
  const cabecalho = Buffer.alloc(6);
  cabecalho.writeUInt16LE(0, 0); // reservado
  cabecalho.writeUInt16LE(1, 2); // 1 = ícone (2 = cursor)
  cabecalho.writeUInt16LE(entradas.length, 4);

  const diretorio = Buffer.alloc(16 * entradas.length);
  let deslocamento = cabecalho.length + diretorio.length;

  entradas.forEach((entrada, i) => {
    const dimensao = entrada.tamanho >= 256 ? 0 : entrada.tamanho;
    const em = i * 16;
    diretorio.writeUInt8(dimensao, em + 0);
    diretorio.writeUInt8(dimensao, em + 1);
    diretorio.writeUInt8(0, em + 2); // paleta: 0 = truecolor
    diretorio.writeUInt8(0, em + 3); // reservado
    diretorio.writeUInt16LE(1, em + 4); // planos
    diretorio.writeUInt16LE(32, em + 6); // bits por pixel
    diretorio.writeUInt32LE(entrada.png.length, em + 8);
    diretorio.writeUInt32LE(deslocamento, em + 12);
    deslocamento += entrada.png.length;
  });

  return Buffer.concat([cabecalho, diretorio, ...entradas.map((e) => e.png)]);
}

if (!fs.existsSync(fonte)) {
  console.error(`Não achei a fonte do ícone em ${path.relative(raiz, fonte)}`);
  process.exit(1);
}

fs.mkdirSync(saida, { recursive: true });

// `contain` com fundo transparente: os tamanhos menores não podem ser cortados,
// e o PNG de origem é quadrado com cantos arredondados, então encolher mantendo
// a proporção não perde nada. Sem o `background`, o `contain` padrão do sharp
// põe um fundo preto opaco nos cantos.
const entradas = [];
for (const tamanho of TAMANHOS) {
  const png = await sharp(fonte)
    .resize(tamanho, tamanho, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  entradas.push({ tamanho, png });
}

// O PNG de 512 vai junto: é o que o electron-builder usa como `icon.png`, e é
// a melhor fonte para re-exportar para onde for preciso.
const png512 = await sharp(fonte).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(path.join(saida, 'icon.png'), png512);

const ico = montarIco(entradas);
fs.writeFileSync(path.join(saida, 'icon.ico'), ico);

const tamanhoDe = (p) => `${(fs.statSync(p).size / 1024).toFixed(1)} KB`;
console.log(`  ${path.relative(raiz, path.join(saida, 'icon.ico'))}  ${tamanhoDe(path.join(saida, 'icon.ico'))}  ${TAMANHOS.join(', ')}`);
console.log(`  ${path.relative(raiz, path.join(saida, 'icon.png'))}  ${tamanhoDe(path.join(saida, 'icon.png'))}  512`);
