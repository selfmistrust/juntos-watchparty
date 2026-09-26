import type { MediaSourceProvider } from './types';
import { unavailable } from './types';

/**
 * Símbolo da Globoplay: o "g" vermelho com o play dentro.
 *
 * Fonte: "Globoplay 2018", Wikimedia Commons, domínio público, autoria Grupo
 * Globo. https://commons.wikimedia.org/wiki/File:Globoplay_2018.svg
 *
 * O arquivo original é o lockup completo (símbolo em cima, wordmark
 * "globoplay" embaixo) e vem como SVG do Inkscape: 11 KB, com transforms
 * aninhados e um `clipPath`. Aqui entraram só duas alterações, ambas
 * verificadas contra o render:
 *
 * 1. Recortei o wordmark. O card é um quadrado de 44px, então o nome não cabe
 *    e rouba a atenção do símbolo, que é o que identifica a aplicação.
 *    O `viewBox` foi medido rasterizando o arquivo e varrendo os pixels:
 *    o símbolo ocupa x 255–694 e y 0–441 do viewBox original.
 * 2. Removi os fills fixos (`#fe1908`/`#f61e22`) para `currentColor`, e o id
 *    do `clipPath` de "a" para "globoplay-clip" — id curto colide com o de
 *    qualquer outro SVG inline da página.
 *
 * O "vazio" branco dentro do símbolo é um buraco de winding, não um retângulo
 * branco: por isso o ícone se adapta a qualquer fundo.
 */
const CLIP_ID = 'globoplay-clip';

const GLYPH_OUTER =
  'M0 0h-152.877c-30.307 0-46.685 17.692-46.685 48.136v91.735c0 30.444 16.378 52.947 46.685 52.947H0c30.308 0 44.279-22.503 44.279-52.947V48.136C44.279 17.692 30.308 0 0 0m-77.293 260.395c-91.118 0-164.983-74.198-164.983-165.725S-168.411-71.056-77.293-71.056 87.69 3.143 87.69 94.67 13.825 260.395-77.293 260.395';

const GLYPH_INNER =
  'M0 0s2.433 35.276 28.092 31.176C48.783 27.87 91.051.708 109.861-17.241c7.649-7.3 8.465-17.005 1.176-26.216-11.355-14.349-48.381-38.025-76.866-49.505C27.903-95.489 2.136-97.253 0-67.219-1.832-41.451 0 0 0 0';

function GloboplayMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="255 0 439 441" fill="currentColor" role="img" aria-label="Globoplay">
      <defs>
        <clipPath id={CLIP_ID} clipPathUnits="userSpaceOnUse">
          <path d="M0 1000h1000V0H0Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${CLIP_ID})`} transform="matrix(1.33184 0 0 -1.33333 -186.072 1023.209)">
        <path d={GLYPH_OUTER} transform="translate(573.775 507.012)" />
        <path d={GLYPH_INNER} transform="translate(446.18 634.383)" />
      </g>
    </svg>
  );
}

/**
 * Globoplay.
 *
 * Como o Drive, fica registrada e indisponível. A Globoplay não tem API pública
 * e o conteúdo é protegido por DRM, então reproduzir na Watch Party exigiria
 * outro modelo de produto (e provavelmente não é permitido pelo contrato).
 * A pessoa pode continuar colando links de vídeo do computador e do YouTube
 * como fazia antes — nada foi removido.
 */
export const globoplayProvider: MediaSourceProvider = {
  id: 'globoplay',
  name: 'Globoplay',
  description: 'Catálogo da Globoplay. Em breve.',
  icon: <GloboplayMark />,
  // Vermelho da marca, o mesmo do arquivo oficial.
  accent: 'text-[#FE1908]',
  resolveState: async () => unavailable('A Globoplay não tem integração disponível.'),
};
