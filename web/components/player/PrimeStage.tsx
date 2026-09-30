'use client';

import { ArrowSquareOutIcon, CheckCircleIcon, PlayIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { desktop, isDesktop } from '@/lib/desktop';
import { ehPaginaDeTitulo, rotuloDoPrime, HOME_PRIME } from '@/lib/prime';
import type { PrimePage } from '@/lib/desktop';
import { CONTAGEM_REGRESSIVA_MS, type Readiness, type User } from '@/types';

/**
 * O palco do Prime Video.
 *
 * ## O que aparece aqui, e o que aparece na view nativa
 *
 * No desktop, o Prime Video **não** é desenhado por este componente. Ele vive
 * numa `WebContentsView` nativa, que o Chromium renderiza por cima da janela —
 * e nada que este componente desenhe ficaria visível por baixo dela. Por isso o
 * palco é uma caixa de medida: ele diz ao `main` onde a view deve ficar, e o
 * que ele mesmo desenha é só a faixa de baixo, que fica **fora** do retângulo
 * enviado. É a mesma contagem que a barra de um player nativo.
 *
 * ## Por que a faixa é nossa, e não do Prime
 *
 * "Assistir com a sala" precisa de um clique nosso, no momento em que a pessoa
 * está na página de um título. A view do Prime é do Prime: não há onde
 * colocar um botão do Juntos sem injetar JavaScript no DOM de um site de
 * terceiro, que é o que esta integração não faz.
 *
 * ## Onde a reprodução fica
 *
 * O Prime Video entrega o vídeo de cada pessoa direto para o aparelho dela,
 * com DRM que este app não lê. Quando o build do Electron não tem o
 * componente de decifração — e o build oficial não tem — a reprodução dentro do
 * app é impossível, e a tela diz isso em vez de mostrar um player preto. O
 * botão "Abrir no Prime Video" é o caminho que funciona em qualquer build.
 */

interface Props {
  item: { id: string; title: string; primeUrl?: string };
  readiness: Readiness | null;
  users: User[];
  meId: string | undefined;
  canControl: boolean;
  /** Chama o servidor: confirma ou desmarca a própria prontidão. */
  onReady: (ready: boolean) => void;
  /** Chama o servidor: começa a contagem regressiva. */
  onCountdown: () => void;
  /** Chama o servidor: zera prontos e contagem. */
  onResync: () => void;
}

interface Drm {
  /** `null` enquanto não respondeu. */
  podeTocarProtegido: boolean | null;
  /** `true` quando nem faz sentido sondar: não estamos no app desktop. */
  semProbe: boolean;
}

export function PrimeStage({ item, readiness, users, meId, canControl, onReady, onCountdown, onResync }: Props) {
  const caixaRef = useRef<HTMLDivElement>(null);
  const [pagina, setPagina] = useState<PrimePage | null>(null);
  const [viewAberta, setViewAberta] = useState(false);
  const [drm, setDrm] = useState<Drm>({ podeTocarProtegido: null, semProbe: !isDesktop() });

  const api = desktop();
  const jaPronto = readiness?.userIds.includes(meId ?? '') ?? false;

  /*
   * Manda o retângulo do palco para a view nativa.
   *
   * `useLayoutEffect` e não `useEffect` aqui: o efeito roda antes do paint,
   * então a view é posicionada no mesmo quadro em que a caixa aparece. Com
   * `useEffect` a view ficaria um quadro no lugar antigo — visível por um
   * instante na posição da faixa anterior, em cima do vídeo de outra pessoa.
   *
   * A soma do scroll entra porque `getBoundingClientRect` é relativo à
   * viewport e a view é posicionada em coordenadas do conteúdo da janela. A
   * janela não rola, então hoje a soma é zero, e ela continua correta se a
   * rolagem do documento voltar a existir.
   */
  const mandarRetangulo = useCallback(() => {
    const el = caixaRef.current;
    if (!el || !api) return;
    const r = el.getBoundingClientRect();
    void api.openPrimeView({
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }, [api]);

  useLayoutEffect(() => {
    if (!api) return;
    mandarRetangulo();
    const el = caixaRef.current;
    /*
     * `ResizeObserver` pega a divisória sendo arrastada, que muda a largura do
     * palco sem a janela mudar nada. O `resize` da janela pega o resto: entrar
     * em tela cheia, maximizar, mudar de monitor. Um só dos dois deixa um
     * caminho sem cobertura, e a view desalinhada cobre o chat.
     */
    const observador =
      el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(mandarRetangulo) : null;
    if (observador && el) observador.observe(el);
    window.addEventListener('resize', mandarRetangulo);
    return () => {
      observador?.disconnect();
      window.removeEventListener('resize', mandarRetangulo);
    };
  }, [api, mandarRetangulo]);

  /*
   * A view do Prime fica aberta só enquanto esta faixa é a que está tocando.
   *
   * Fechar no cleanup é o que garante que trocar de faixa não deixe uma aba do
   * Prime flutuando sobre o vídeo seguinte: a sessão `persist:prime` continua
   * em disco, então quem volta ao Prime não precisa logar de novo.
   */
  useEffect(() => {
    if (!api) return;
    return () => {
      void api.closePrimeView();
    };
  }, [api, item.id]);

  /* A página do Prime muda quando a pessoa navega lá dentro — não há como saber
   * por outro caminho, e não há leitura de DOM para fazer. */
  useEffect(() => {
    if (!api) return;
    let cancelado = false;
    void api.primePage().then((p) => {
      if (!cancelado) setPagina(p);
    });
    const parar = api.onPrimePage((p) => {
      if (!cancelado) setPagina(p);
    });
    return () => {
      cancelado = true;
      parar();
    };
  }, [api, item.id]);

  /*
   * O que este build do Electron consegue decifrar.
   *
   * A pergunta vai para o motor, não para o Prime, e a resposta `false` é
   * definitiva: o build oficial do Electron não traz o CDM do Widevine, e
   * nenhum título protegido toca dentro do app. Só no desktop vale sondar — na
   * web nem existe view para tocar.
   */
  useEffect(() => {
    if (!api || drm.podeTocarProtegido !== null) return;
    let cancelado = false;
    void api.primeCanPlayProtected().then((pode) => {
      if (!cancelado) setDrm({ podeTocarProtegido: pode, semProbe: false });
    });
    return () => {
      cancelado = true;
    };
  }, [api, drm.podeTocarProtegido]);

  /** Abre o título da fila na view nativa, ou no navegador do sistema se não houver. */
  const abrirTitulo = useCallback(async () => {
    const url = item.primeUrl;
    if (!url) return;
    if (api) {
      const ok = await api.primeNavigate(url);
      if (ok) {
        setViewAberta(true);
        mandarRetangulo();
        return;
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [api, item.primeUrl, mandarRetangulo]);

  const faltam = users.filter((u) => u.connected && !readiness?.userIds.includes(u.userId));
  const prontos = (readiness?.userIds.length ?? 0) === 0 ? 0 : readiness?.userIds.length ?? 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-black">
      {/*
        * A caixa de medida. Vazia de propósito: o conteúdo vem da view nativa,
        * e qualquer coisa desenhada aqui ficaria atrás dela. O aviso de DRM
        * mora **fora** desta caixa, na faixa de baixo, pelo mesmo motivo.
      */}
      <div ref={caixaRef} className="relative min-h-0 flex-1 bg-black">
        {/*
          * Primeiro quadro: a view ainda não foi posicionada, e a área ficaria
          * preta. O texto diz o que está acontecendo em vez de fingir que o
          * vídeo carregou — uma tela preta sem explicação é indistinguível de
          * "quebrou", que é a pior coisa que um player pode fazer.
          */}
        {/*
         * Primeiro quadro: a view ainda não foi posicionada, e a área ficaria
         * preta. O texto diz o que está acontecendo em vez de fingir que o
         * vídeo carregou — uma tela preta sem explicação é indistinguível de
         * "quebrou", que é a pior coisa que um player pode fazer.
         *
         * Na web não existe view nenhuma, e a mensagem seria uma promessa que
         * não se cumpre. O caminho de lá é a outra aba, e é o que a tela diz.
         */}
        {!api && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-sm text-sm text-ink-muted">
              Este título é assistido no seu próprio Prime Video, na sua conta.
            </p>
            <Button onClick={() => abrirTitulo()} className="h-9 gap-1.5">
              <ArrowSquareOutIcon size={15} />
              Abrir no Prime Video
            </Button>
          </div>
        )}
        {api && !viewAberta && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-ink-muted">Abrindo o Prime Video…</p>
            <p className="text-2xs text-ink-faint">
              O login é feito na conta de quem assiste, dentro do app.
            </p>
          </div>
        )}
      </div>

      {/*
        * A faixa de baixo. Fora da caixa de medida, então é a única parte desta
        * tela que o Prime não cobre — e é por isso que o botão "Assistir com a
        * sala" pode existir sem injeção de JavaScript no site.
      */}
      <div className="shrink-0 space-y-2 border-t border-hairline bg-surface px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-ink-faint">
            Prime Video
          </span>
          <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted" title={pagina?.titulo}>
            {pagina?.titulo || item.title}
          </span>
          {item.primeUrl && (
            <IconButton
              label={`Abrir ${rotuloDoPrime(item.primeUrl)} no navegador`}
              onClick={() => window.open(item.primeUrl, '_blank', 'noopener,noreferrer')}
            >
              <ArrowSquareOutIcon size={15} />
            </IconButton>
          )}
        </div>

        {/*
         * O botão que abre a faixa na Prime de quem está olhando.
         *
         * Sem ele, quem acabou de receber o título teria que colar a URL na
         * mão dentro da view do Prime — e a view está ocupada pelo catálogo. O
         * caminho quando não há view é a outra aba, que é o mesmo destino:
         * o Prime Video de cada pessoa, na conta de cada pessoa.
         */}
        {item.primeUrl && (
          <Button onClick={() => abrirTitulo()} variant="outline" className="h-8 w-full justify-center gap-1.5">
            <ArrowSquareOutIcon size={14} />
            Abrir este título no meu Prime Video
          </Button>
        )}

        {/*
          * A sonda de DRM.

          * `false` é o caso que importa: aqui não há reprodução dentro do app,
          * e a tela precisa dizer isso com a frase que a pessoa entende
          * — "não está disponível na sua conta" é o sintoma que ela conhece,
          * e não a razão. `true` não promete que toca: a Prime Video ainda
          * pode recusar por VMP na hora de dar play, e por isso o botão
          * "Abrir no Prime Video" fica sempre à mão.
        */}
        {drm.podeTocarProtegido === false && (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Este build do aplicativo não reproduz vídeo protegido dentro dele. Cada pessoa
            assiste no próprio Prime Video — no navegador, na conta dela.
          </p>
        )}

        {/*
          * Prontidão. É o que substitui a sincronização de player aqui: cada um
          * abre o título na conta própria, confirma, e a sala começa junta.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => onReady(!jaPronto)}
            variant={jaPronto ? 'ghost' : 'primary'}
            className="h-9 gap-1.5"
          >
            <CheckCircleIcon size={15} weight={jaPronto ? 'fill' : 'regular'} />
            {jaPronto ? 'Estou pronto' : 'Avisar que estou pronto'}
          </Button>

          {readiness?.countdownAt != null && (
            <ContagemRegressiva desde={readiness.countdownAt} />
          )}

          {prontos > 0 && (
            <span className="text-2xs text-ink-faint">
              {prontos} de {users.filter((u) => u.connected).length} prontos
            </span>
          )}

          {canControl && (
            <>
              <Button onClick={onCountdown} disabled={readiness?.countdownAt != null} className="h-9 gap-1.5">
                <PlayIcon size={15} weight="fill" />
                Começar agora
              </Button>
              <Button onClick={onResync} variant="outline" className="h-9">
                Ressincronizar
              </Button>
            </>
          )}
        </div>

        {faltam.length > 0 && (
          <TruncatedText
            text={`Ainda não: ${faltam.map((u) => u.name).join(', ')}`}
            className="block text-2xs text-ink-faint"
          />
        )}
      </div>
    </div>
  );
}

/**
 * A contagem 5, 4, 3, 2, 1.
 *
 * O número vem de `countdownAt`, que é do servidor — se cada cliente contasse do
 * seu `performance.now()`, duas máquinas com relógios diferentes começariam a
 * contagem em instantes diferentes e a sala daria play fora de sincronia, que é
 * exatamente o que a contagem existe para evitar.
 *
 * Depois de `CONTAGEM_REGRESSIVA_MS` ela vira "já pode começar": o número não
 * fica em zero nem em "1" para sempre, porque uma contagem travada em 1 é
 * indistinguível de um app quebrado.
 */
function ContagemRegressiva({ desde }: { desde: number }) {
  const [restante, setRestante] = useState(() => Math.max(0, CONTAGEM_REGRESSIVA_MS - (Date.now() - desde)));

  useEffect(() => {
    const t = setInterval(() => setRestante(Math.max(0, CONTAGEM_REGRESSIVA_MS - (Date.now() - desde))), 250);
    return () => clearInterval(t);
  }, [desde]);

  if (restante <= 0) return <span className="text-2xs font-medium text-accent">Já pode começar</span>;
  return (
    <span className="text-2xs font-medium text-accent" aria-live="polite">
      {Math.ceil(restante / 1000)}
    </span>
  );
}

/**
 * Botão de adicionar a página atual do Prime à fila.
 *
 * Vive na faixa de baixo, e é o único caminho para "Assistir com a sala".
 * Fica desabilitado fora de uma página de título: a URL da home não identifica
 * um filme, e adicionar isso à fila mostraria a mesma coisa para todo mundo da
 * sala.
 */
export function BotaoAssistirComSala({
  pagina,
  onAdicionar,
}: {
  pagina: PrimePage | null;
  onAdicionar: (url: string, titulo: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const api = desktop();
  const [digitado, setDigitado] = useState('');

  /* Na web não há view, então a URL é colada. O campo aceita o endereço que a
   * pessoa acabou de copiar da barra do navegador, e `normalizarUrlDoPrime`
   * (no `lib/prime`) recusa o que não for página de título — com a mensagem
   * certa, em vez de um item silenciosamente inválido na fila. */
  useEffect(() => {
    if (api) return;
    setUrl(ehPaginaDeTitulo(digitado) ? digitado : null);
  }, [api, digitado]);

  if (!api) {
    return (
      <div className="space-y-2">
        <p className="text-2xs leading-relaxed text-ink-faint">
          O Prime Video não pode ser incorporado nesta versão, e o site recusa ser exibido dentro
          de outro site. Abra o Prime numa aba, escolha o título e cole o endereço da página aqui.
        </p>
        <a
          href={HOME_PRIME}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-2xs text-accent hover:underline"
        >
          Abrir o Prime Video
          <ArrowSquareOutIcon size={12} />
        </a>
        <input
          value={digitado}
          onChange={(e) => setDigitado(e.target.value)}
          placeholder="Cole aqui o endereço da página do título"
          aria-label="Endereço da página do título no Prime Video"
          className="w-full rounded-md border border-hairline bg-raised px-2.5 py-2 text-2xs text-ink placeholder:text-ink-faint focus:outline-none focus-visible:border-accent"
        />
        {url && (
          <Button onClick={() => onAdicionar(url, 'Título do Prime Video')} className="h-9 w-full justify-center">
            Assistir com a sala
          </Button>
        )}
      </div>
    );
  }

  const naPaginaDeTitulo = pagina?.isTitulo === true && ehPaginaDeTitulo(pagina.url);
  return (
    <Button
      onClick={() => pagina && onAdicionar(pagina.url, pagina.titulo || 'Título do Prime Video')}
      disabled={!naPaginaDeTitulo}
      className={clsx('h-10 w-full justify-center')}
    >
      Assistir com a sala
    </Button>
  );
}
