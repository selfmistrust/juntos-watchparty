/**
 * Gera o ícone das notificações de menção.
 *
 * ## Por que um arquivo e não o favicon
 *
 * A notificação do sistema mostra um ícone, e sem `icon` explícito o Chrome usa
 * o favicon da página — que no Juntos é o logo do app. Numa notificação de
 * "fulano te mencionou", um logo do site faz a notificação parecer que o próprio
 * site está falando, e a pessoa não distingue um convite de uma menção.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const destino = path.join(aqui, '..', 'public', 'mention-48x48.png');

/** PNG sem dependência: zlib do próprio Node + CRC. */
import zlib from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo, dados) {
  const comprimento = Buffer.alloc(4);
  comprimento.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([comprimento, corpo, crc]);
}

const L = 48;
const px = Buffer.alloc(L * L * 4);

/**
 * Um balão de fala com cauda, na cor do accent.
 *
 * ## Por que um balão e não um `@`
 *
 * A primeira intenção era desenhar um `@`, e o comentário dizia `@`. O PNG
 * gerado foi aberto e não é um `@`: é um anel com uma abertura embaixo à
 * direita e um rabo, que lê como **balão**. E lendo como balão é melhor.
 *
 * O ícone aparece primeiro com 16px, na bandeja do sistema. Um `@` em 16px vira
 * um borrão com um furo no meio, e não dá para saber se era arroba ou só um
 * círculo. O balão continua sendo balão em 16px, e a informação que passa —
 * "falaram com você" — é a mesma.
 *
 * Sem fonte de propósito: renderizar texto em PNG sem biblioteca de texto daria
 * um resultado diferente em cada máquina, e ícone de notificação é o lugar onde
 * variação é pior.
 */
const centroX = 24;
const centroY = 25;
const raioCentro = 9.5; // o miolo
const raioBoca = 14.5; // a volta externa
const espessura = 4.2;

function dentroDoBalao(x, y) {
  const dx = x - centroX;
  const dy = y - centroY;
  const d = Math.hypot(dx, dy);

  // A volta: anel entre raioBoca e raioBoca - espessura, aberto embaixo-direita.
  if (d <= raioBoca && d >= raioBoca - espessura) {
    if (dy > 2 && dx > 0) return false; // a abertura
    return true;
  }
  // O miolo.
  if (d <= raioCentro && d >= raioCentro - espessura * 0.95) return true;
  // A cauda, descendo do canto inferior direito.
  if (dx > 8 && dx < 13 && dy > 8 && dy < 17) return true;
  return false;
}

for (let y = 0; y < L; y++) {
  for (let x = 0; x < L; x++) {
    const i = (y * L + x) * 4;
    const dentro = dentroDoBalao(x + 0.5, y + 0.5);
    if (dentro) {
      px[i] = 0x7c; // roxo do accent
      px[i + 1] = 0x5c;
      px[i + 2] = 0xff;
      px[i + 3] = 255;
    } else {
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
      px[i + 3] = 0;
    }
  }
}

/** Cada linha do PNG começa com o byte de filtro, 0 = nenhum. */
const linhas = Buffer.alloc((L * 4 + 1) * L);
for (let y = 0; y < L; y++) {
  linhas[y * (L * 4 + 1)] = 0;
  px.copy(linhas, y * (L * 4 + 1) + 1, y * L * 4, (y + 1) * L * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(L, 0);
ihdr.writeUInt32BE(L, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(linhas)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, png);
console.log(`Ícone de menção escrito em ${path.relative(process.cwd(), destino)} (${png.length} bytes)`);
