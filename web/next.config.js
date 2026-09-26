/**
 * `distDir` separado por ambiente.
 *
 * `next dev` e `next build` escrevem no mesmo lugar por padrão, e rodar um
 * enquanto o outro está no ar corrompe o diretório: o build deixa
 * `.next/server/pages` incompleto e o dev serve um `ENOENT` de `_document.js`.
 * Já aconteceu mais de uma vez aqui, e a mensagem de erro não aponta para a
 * causa real.
 *
 * Cada ambiente ganha o seu diretório, então os dois convivem. A variável é
 * lida do `.env.local` (ver o bloco abaixo) e cai para `.next-dev` no dev e
 * `.next-build` no build, que é o padrão quando ninguém define nada.
 */
const DEV = process.env.NODE_ENV !== 'production';
const distDir =
  process.env.NEXT_DIST_DIR || (DEV ? '.next-dev' : '.next-build');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  distDir,
  images: { remotePatterns: [{ protocol: 'https', hostname: 'i.ytimg.com' }] },
};
module.exports = nextConfig;
