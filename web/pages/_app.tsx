import type { AppProps } from 'next/app';
import { Bricolage_Grotesque, Inter } from 'next/font/google';
import Head from 'next/head';
import { YoutubeAccountProvider } from '@/hooks/useYouTubeAccount';
import '@/styles/globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

/** Bricolage Grotesque só nos títulos: dá personalidade sem atrapalhar a leitura da UI. */
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['600', '700'],
  display: 'swap',
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>juntos | watchparty</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta
          name="description"
          content="Salas de watchparty com video sincronizado, chat em tempo real e fila colaborativa."
        />
        <meta name="theme-color" content="#08080A" />

        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
      </Head>
      <div className={`${inter.variable} ${display.variable} font-sans`}>
        <YoutubeAccountProvider>
          <Component {...pageProps} />
        </YoutubeAccountProvider>
        {/* Alvo dos portais (pickers, dropdowns). Fica dentro deste wrapper de
            propósito: é daqui que o conteúdo teleportado herda a tipografia do
            design system. Se for movido para o <body>, tudo que passar pelo
            `Portal` volta a ser renderizado na serifada padrão. */}
        <div id="portal-root" />
      </div>
    </>
  );
}