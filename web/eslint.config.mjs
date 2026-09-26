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
      'node_modules/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      '**/*.tsbuildinfo',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
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
