const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');

/**
 * `distDir` separado só para o servidor de desenvolvimento.
 *
 * O problema original era local: `next dev` e `next build` escrevem no mesmo
 * lugar por padrão, e rodar um enquanto o outro está no ar corrompe o
 * diretório — o build deixa `.next/server/pages` incompleto e o dev passa a
 * servir `ENOENT` de `_document.js`. Já aconteceu mais de uma vez aqui, e a
 * mensagem de erro não aponta para a causa real.
 *
 * A chave é a *fase* do Next, não o `NODE_ENV`. Isso importa porque o build de
 * produção precisa terminar em `.next`, que é o que a Vercel procura depois do
 * `next build`: o `Output Directory` do projeto aponta para lá, e um
 * `distDir` diferente — mesmo funcionando perfectly no build — faz o deploy
 * falhar com "routes-manifest.json couldn't be found" logo depois de o build
 * ter dado certo. Já aconteceu.
 *
 * Então: `next dev` usa `.next-dev`, `next build` usa `.next`. Os dois ainda
 * convivem localmente, porque o dev nunca toca no diretório do build.
 *
 * O override por variável existe, mas é aceito **apenas no dev**, para não
 * haver como empurrar o build de produção para fora de `.next`.
 *
 * @type {(phase: string) => import('next').NextConfig}
 */
module.exports = (phase) => {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const distDir = (dev && process.env.NEXT_DIST_DIR) || (dev ? '.next-dev' : '.next');

  return {
    reactStrictMode: true,
    devIndicators: false,
    distDir,
    images: { remotePatterns: [{ protocol: 'https', hostname: 'i.ytimg.com' }] },
  };
};
