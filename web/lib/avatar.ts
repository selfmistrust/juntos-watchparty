/**
 * Avatares gerados via DiceBear (https://dicebear.com), sem precisar de chave
 * nem de servidor próprio: é só uma URL de SVG determinística a partir de uma
 * semente. Estilo "thumbs" fica legível em tamanhos pequenos (24–64px).
 */
const STYLE = 'thumbs';

export function randomAvatarSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function dicebearUrl(seed: string): string {
  const params = new URLSearchParams({
    seed,
    backgroundType: 'gradientLinear',
    radius: '50',
  });
  return `https://api.dicebear.com/9.x/${STYLE}/svg?${params.toString()}`;
}
