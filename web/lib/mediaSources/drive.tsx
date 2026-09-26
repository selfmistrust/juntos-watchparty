import type { MediaSourceProvider } from './types';
import { unavailable } from './types';

/**
 * Ícone do Google Drive.
 *
 * Fonte: "Google Drive icon (2026)", Wikimedia Commons, domínio público,
 * autoria Google. https://commons.wikimedia.org/wiki/File:Google_Drive_icon_(2026).svg
 *
 * Duas alterações sobre o arquivo original, ambas necessárias para embutir:
 *
 * 1. Adicionei `viewBox="0 0 800 741.37"`. O original traz só `width`/`height`,
 *    e sem `viewBox` o SVG não escala — num card de 44px ele sairia do tamanho
 *    fixo em vez de se adaptar.
 * 2. Renomeei os ids: a máscara era `a` e os gradientes eram `b`, `c` e `d`.
 *    Id é global no documento, e um id de um caractere colide com o de qualquer
 *    outro SVG inline da página — o `clipPath` da Globoplay já quase fez isso.
 *
 * As cores não foram convertidas para `currentColor`: a marca do Drive é
 * justamente o gradiente azul/verde/amarelo, e achatá-lo para uma cor só
 * perderia o que faz o ícone ser reconhecido.
 */
function DriveMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size * (741.37 / 800)}
      viewBox="0 0 800 741.37"
      fill="none"
      role="img"
      aria-label="Google Drive"
    >
      <mask id="gdrive-mask" width="168" height="154" x="12" y="18" maskUnits="userSpaceOnUse">
        <path fill="#fff" d="M63.09 37c14.626-25.333 51.193-25.334 65.819 0l45.033 78c14.626 25.334-3.657 57.001-32.91 57.001H50.967c-29.253 0-47.536-31.667-32.91-57.001Z" />
      </mask>
      <defs>
        <linearGradient id="gdrive-yellow" x1="193.6" x2="103.09" y1="165.6" y2="111.21" gradientUnits="userSpaceOnUse">
          <stop offset=".09" stopColor="#ffe921" />
          <stop offset="1" stopColor="#fec700" />
        </linearGradient>
        <linearGradient id="gdrive-blue" x1="114.4" x2="15.53" y1="181.61" y2="121.8" gradientUnits="userSpaceOnUse">
          <stop offset=".15" stopColor="#a9a8ff" />
          <stop offset=".33" stopColor="#6d97ff" />
          <stop offset=".48" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient id="gdrive-green" x1="128.88" x2="28.7" y1="37.88" y2="84.64" gradientUnits="userSpaceOnUse">
          <stop offset=".55" stopColor="#0ebc5f" />
          <stop offset=".85" stopColor="#78c9ff" />
        </linearGradient>
      </defs>
      <g mask="url(#gdrive-mask)" transform="matrix(4.8140532,0,0,4.8140532,-62.146701,-86.652356)">
        <path fill="url(#gdrive-yellow)" d="M206.905 172.02h-91.888l-19.015-32.934 45.944-79.578Z" />
        <path fill="url(#gdrive-blue)" d="M-14.919 172.006 50.04 59.494v.002L31.032 92.422h38.02L115 172.004l-129.918.001Z" />
        <path fill="url(#gdrive-green)" d="M96.007-20.085 141.954 59.5l-19.011 32.928H31.048Z" />
      </g>
    </svg>
  );
}

/**
 * Google Drive.
 *
 * A integração existe no modal desde já, mas fica indisponível: o item de
 * playlist atual guarda `kind` + `src`, e o Drive não entrega um link direto de
 * vídeo reproduzível no navegador — precisaria de proxy no servidor, com
 * autenticação por sala. Esse trabalho é de backend e fica de fora desta
 * entrega.
 *
 * A entrada está aqui de propósito: mostra que "aplicação indisponível" é um
 * estado de primeira classe, e o lugar do código já está reservado para quando
 * o proxy existir.
 */
export const driveProvider: MediaSourceProvider = {
  id: 'drive',
  name: 'Google Drive',
  description: 'Vídeos do seu Drive. Em breve.',
  icon: <DriveMark />,
  // O ícone já tem as cores da marca, então este `accent` não chega a ser
  // usado. Fica no azul oficial (#3186FF) para o caso de o card cair no
  // `currentColor` em algum caminho.
  accent: 'text-[#3186FF]',
  resolveState: async () => unavailable('O Drive precisa de um servidor intermediário. Em breve.'),
};
