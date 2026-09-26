import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

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
];

export default config;
