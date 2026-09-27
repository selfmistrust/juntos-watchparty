import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * Regra que faz cada arquivo `.js` de `public/` ser parseado de verdade.
 *
 * `acorn` é o mesmo parser que o navegador usa para decidir se o arquivo
 * executa, e é ele que pega um `as` no meio do código. A diferença entre esta
 * regra e uma regra de estilo é que ela falha no mesmo lugar e pelo mesmo
 * motivo que o bug: o arquivo não é JavaScript.
 *
 * Sem isto, nada no projeto detecta um service worker escrito em TypeScript
 * até alguém abrir a sala e ver um player quebrado sem explicação.
 */
const arquivoValido = {
  rules: {
    parse: {
      meta: { type: 'problem' },
      create(context) {
        const nome = context.filename;
        return {
          Program() {
            const fonte = readFileSync(nome, 'utf8');
            try {
              parse(fonte, { ecmaVersion: 2022, sourceType: 'script' });
            } catch (erro) {
              const linha = erro.loc?.line;
              context.report({
                node: context.sourceCode.ast,
                message:
                  `'${nome.replace(process.cwd(), '.')}' não é JavaScript válido e é servido sem compilador: ` +
                  `${erro.message}${linha ? ` (linha ${linha})` : ''}. ` +
                  'Um arquivo em public/ não pode usar sintaxe de TypeScript: o navegador não entende.',
              });
            }
          },
        };
      },
    },
  },
};

/**
 * Flat config, no formato que o `next lint` usava por baixo (via FlatCompat
 * para reusar os presets shareable do Next).
 *
 * `next/core-web-vitals` traz as regras de acessibilidade e de SEO que o
 * Next considera erro de build; `next/typescript` adiciona as regras do
 * TypeScript que valem para quem tem `@typescript-eslint` presente.
 */
const config = [
  {
    ignores: [
      '.next/**',
      // `distDir` do servidor de desenvolvimento (ver next.config.js): o dev
      // vai para `.next-dev` e o build para `.next`, e nenhum dos dois é
      // código-fonte.
      '.next-dev/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      '**/*.tsbuildinfo',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['next.config.js'],
    rules: {
      // O `package.json` do front não é `"type": "module"`, então o Next
      // carrega este arquivo como CommonJS e o `require` é a forma correta de
      // pegar `PHASE_DEVELOPMENT_SERVER`. Renomear para `.mjs` resolveria, mas
      // a regra existe para pegar `require` esquecido em código de app, e
      // exemptar um arquivo de configuração do build não é o mesmo que
      // desligar a regra no resto.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      // O projeto usa `<img>` de propósito em miniaturas e avatares: são
      // imagens remotas de terceiros (YouTube, avatars) que não passam pelo
      // loader do Next, e o otimizador local não acrescentaria nada. As
      // exceções estão marcadas no ponto de uso.
      '@next/next/no-img-element': 'warn',
    },
  },
  {
    /*
     * `public/` é servido como está, byte a byte, sem passar por compilador
     * nenhum. Um arquivo com sintaxe de TypeScript parece funcionar — o editor
     * formata, o realce aceita, o typecheck do projeto passa, porque ninguém
     * olha — e só quebra no navegador, com `SyntaxError` na primeira linha que
     * usa anotação de tipo.
     *
     * A consequência é silenciosa e enganosa: o worker não registra, nenhuma
     * requisição é interceptada, e o `<video>` recebe 404 da hospedagem. O
     * erro na tela não tem nada a ver com a causa, que é o pior tipo de bug: um
     * sintoma que aponta para o lugar errado.
     *
     * Por que uma regra do ESLint não serviria aqui:
     *
     * A primeira tentativa foi uma regra de estilo nos arquivos `.js` de
     * `public/`, e ela não pegava
     * nada: o preset do Next não traz parser de TypeScript para arquivos `.js`
     * nesse caminho, então o `as` passava limpo. A regra parecia acrescentar
     * segurança e não acrescentava nada — que é pior do que não ter regra,
     * porque ela passa a ser o lugar onde se confia que o problema foi
     * resolvido.
     *
     * Por isso o arquivo é **parseado de verdade**, com o mesmo parser que o
     * navegador usa, e qualquer `.js` que não parse como JavaScript falha o
     * lint. Ver o arquivo quebrar é o teste; não é uma regra sobre o texto.
     */
    files: ['public/**/*.js'],
    plugins: { js: arquivoValido },
    rules: {
      'js/parse': 'error',
    },
  },
];

export default config;
