'use client';

import { ArrowSquareOutIcon, CheckCircleIcon, PlayIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { TruncatedText } from '@/components/ui/TruncatedText';
import { desktop } from '@/lib/desktop';
import { HOME_PRIME, rotuloDoPrime } from '@/lib/prime';
import type { PrimePage } from '@/lib/desktop';
import { CONTAGEM_REGRESSIVA_MS, type Readiness, type User } from '@/types';

/**
 * O Prime Video dentro do palco do Juntos.
 *
 * ## O Prime não é desenhado aqui
 *
 * Ele vive numa `WebContentsView` nativa, que o Chromium renderiza **por cima**
 * da janela. Nada que este componente desenhe ficaria visível sob ela — e é por
 * isso que este arquivo tem duas metades bem separadas:
 *
 *   a caixa de medida   diz ao `main` onde a view deve ficar
 *   a faixa de baixo    fica **fora** desse retângulo, e é a única parte da
 *                       tela que o Prime não cobre
 *
 * Todo botão nosso mora na faixa. Por isso "Assistir com a sala" existe sem
 * injeção de JavaScript no DOM do Prime: ele é nosso, e a view do Prime não
 * precisa saber que ele está ali.
 *
 * ## Dois modos, um componente
 *
 * `PrimeViewport` é a navegação: a pessoa abriu o Prime Video pelo card e está
 * no catálogo, sem nenhum item na fila. `PrimeStage` é a reprodução: há um item
 * `prime` tocando, e a faixa ganha a contagem de prontos.
 *
 * A diferença é a faixa, não a caixa. Separar os dois em componentes
 * diferentes duplicaria o posicionamento da view — que é a parte que dá errado
 * sozinha — em dois lugares.
 *
 * ## Onde a reprodução fica
 *
 * O Prime Video entrega o vídeo de cada pessoa direto para o aparelho dela,
 * com DRM que este app não lê. Quando o build do Electron não traz o
 * componente de decifração — e o build oficial não traz — o vídeo protegido
 * não toca dentro do app, e a faixa diz isso com a frase que a pessoa
 * reconhece. "Abrir no navegador" fica sempre à mão.
 */

/** Tudo que as duas metades precisam saber da faixa. */
interface FaixaProps {
  /** Título do item `prime` em reprodução, quando houver um. */
  tituloDaFaixa?: string;
  /** URL do item em reprodução — é a que a view recebe ao virar a faixa. */
  urlDaFaixa?: string;
  /** Salva a página do Prime como item da fila. Ausente = só navegar. */
  onAssistirComSala?: (url: string, titulo: string) => void;
  /** Sai do Prime Video e devolve o palco ao estado vazio. */
  onFechar: () => void;
  /** Bloco extra abaixo da faixa — a contagem de prontos, no modo reprodução. */
  children?: ReactNode;
}

function PrimeBase({ tituloDaFaixa, urlDaFaixa, onAssistirComSala, onFechar, children }: FaixaProps) {
  const caixaRef = useRef<HTMLDivElement>(null);
  const [pagina, setPagina] = useState<PrimePage | null>(null);
  const [viewAberta, setViewAberta] = useState(false);
  const [podeTocarProtegido, setPodeTocarProtegido] = useState<boolean | null>(null);
  /** Último destino enviado à view, para não repetir a mesma navegação. */
  const navegadoPara = useRef<string | null>(null);

  const api = desktop();

  /*
   * Manda o retângulo da caixa para a view nativa.
   *
   * `useLayoutEffect` e não `useEffect`: o efeito roda antes do paint, então a
   * view é posicionada no mesmo quadro em que a caixa aparece. Com `useEffect`
   * ela ficaria um quadro no lugar antigo — visível por um instante sobre o
   * vídeo de outra pessoa.
   *
   * A soma do scroll entra porque `getBoundingClientRect` é relativo à viewport
   * e a view é posicionada em coordenadas do conteúdo da janela. A janela não
   * rola, então hoje a soma é zero, e ela continua correta se a rolagem do
   * documento voltar a existir.
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
     * Os quatro momentos em que a caixa muda de lugar ou de tamanho, e quem
     * pega cada um:
     *
     *   redimensionar a janela      `resize`
     *   arrastar a divisória        `ResizeObserver` — a largura muda sem a
     *                               janela mudar nada
     *   ocultar o painel lateral    `ResizeObserver` — o palco ganha a largura
     *   entrar/sair de tela cheia   `ResizeObserver` — a caixa troca de tamanho
     *
     * Um só dos dois deixaria um caminho sem cobertura, e a falha é a pior
     * possível: a view desalinhada cobre o chat, o cabeçalho ou os controles
     * do Juntos, e cliques que deveriam ir para o painel vão para o Prime.
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
   * A view vive enquanto esta faixa estiver montada.
   *
   * Fechar no cleanup é o que garante que trocar de fonte não deixe uma aba do
   * Prime flutuando sobre o vídeo seguinte — e o `main` **remove a view do
   * `contentView`**, em vez de escondê-la: uma view invisível ainda
   * participa do hit-test, e é assim que o Prime passa a engolir clique do chat.
   *
   * A sessão `persist:juntos-prime` continua em disco, então quem volta ao
   * Prime não precisa logar de novo.
   */
  useEffect(() => {
    if (!api) return;
    return () => {
      void api.closePrimeView();
    };
  }, [api]);

  /*
   * A página do Prime muda quando a pessoa navega lá dentro.
   *
   * Não há outro caminho para saber disso, e não há leitura de DOM para fazer:
   * o `main` escuta `did-navigate` e `did-navigate-in-page` e empurra a URL.
   */
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
  }, [api]);

  /*
   * A view entrou em uso.
   *
   * O estado existe porque o `openPrimeView` é assíncrono e o primeiro quadro
   * da caixa ainda ficaria preto. A resposta vem do `main`, e só depois dela a
   * caixa deixa de anunciar "abrindo" — a tela preta sem explicação é
   * indistinguível de "quebrou", que é a pior coisa que um player pode fazer.
   */
  useEffect(() => {
    if (!api) return;
    let cancelado = false;
    const parar = api.onPrimePage(() => {
      if (!cancelado) setViewAberta(true);
    });
    // A view pode já estar numa página: quem abriu o Prime numa sessão anterior
    // não emite evento de navegação agora, e a caixa ficaria em "abrindo" para
    // sempre. `primePage` é a consulta, e devolve `url` vazia se nunca abriu.
    void api.primePage().then((p) => {
      if (!cancelado && p.url) setViewAberta(true);
    });
    return () => {
      cancelado = true;
      parar();
    };
  }, [api]);

  /*
   * O que este build do Electron consegue decifrar.
   *
   * A pergunta vai ao motor, não ao Prime: `requestMediaKeySystemAccess`
   * responde se este Chromium decifra, e não tem nada a ver com a conta de
   * quem assiste nem com a assinatura do título.
   *
   * `false` é resposta definitiva — o build oficial do Electron não traz o CDM
   * do Widevine. `true` é só o mínimo: a Prime Video ainda pode recusar na hora
   * de tocar por causa da checagem de VMP. Por isso a faixa nunca promete que
   * toca, e "Abrir no navegador" fica sempre à mão.
   */
  useEffect(() => {
    if (!api || podeTocarProtegido !== null) return;
    let cancelado = false;
    void api.primeCanPlayProtected().then((pode) => {
      if (!cancelado) setPodeTocarProtegido(pode);
    });
    return () => {
      cancelado = true;
    };
  }, [api, podeTocarProtegido]);

  /*
   * Para onde a view vai.
   *
   * A home do Prime quando a pessoa abriu pelo card, e a URL do título quando
   * há um item tocando. Uma navegação só, decidida aqui: o main cria a view e
   * posiciona, e quem escolhe o destino é quem sabe o que a pessoa está
   * fazendo.
   *
   * É também o que faz o participante não precisar digitar nada. Quem escolheu
   * o título o vê aparecer na conta de cada um, na sessão da **própria** pessoa —
   * e quem não tem assinatura vê a recusa do Prime Video, que é a resposta
   * certa.
   *
   * O guard por `navegadoPara` é o que impede a luta: sem ele, cada
   * `did-navigate` dispararia uma navegação de volta e a pessoa ficaria presa
   * na página do host sem poder navegar no catálogo.
   */
  useEffect(() => {
    if (!api) return;
    const destino = urlDaFaixa && urlDaFaixa !== '' ? urlDaFaixa : HOME_PRIME;
    if (navegadoPara.current === destino) return;
    navegadoPara.current = destino;
    void api.primeNavigate(destino).then((ok) => {
      // Falhou: a URL foi recusada pelo `main`, ou a view ainda não existia.
      // O guard volta um passo para o próximo destino tentar de novo.
      if (!ok) navegadoPara.current = null;
    });
  }, [api, urlDaFaixa]);

  const naPaginaDeTitulo = pagina?.isTitulo === true && pagina.url !== '';

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-black">
      {/*
        * A caixa de medida. Vazia de propósito: o conteúdo vem da view nativa,
        * e qualquer coisa desenhada aqui ficaria atrás dela.
        */}
      <div ref={caixaRef} className="relative min-h-0 flex-1 bg-black">
        {!api && (
          /*
           * Só na web, e sem campo para colar nada.
           *
           * O Prime Video recusa ser exibido dentro de outro site, e o caminho
           * de lá é a outra aba. Um campo de URL aqui seria a experiência
           * principal de uma integração que na web não existe — e foi
           * exatamente o que o app mostrou.
           */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-sm text-sm text-ink-muted">
              O Prime Video integrado fica dentro do aplicativo Desktop, na área do player.
            </p>
            <Button onClick={() => window.open('https://www.primevideo.com/', '_blank', 'noopener,noreferrer')} className="h-9 gap-1.5">
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
        * A faixa de baixo, fora da caixa de medida — a única parte da tela que
        * o Prime não cobre.
        */}
      <div className="shrink-0 space-y-2 border-t border-hairline bg-surface px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-ink-faint">
            Prime Video
          </span>
          <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted" title={pagina?.titulo}>
            {pagina?.titulo || tituloDaFaixa || ''}
          </span>
          {urlDaFaixa && (
            <IconButton
              label={`Abrir ${rotuloDoPrime(urlDaFaixa)} no navegador`}
              onClick={() => window.open(urlDaFaixa, '_blank', 'noopener,noreferrer')}
            >
              <ArrowSquareOutIcon size={15} />
            </IconButton>
          )}
          <IconButton label="Sair do Prime Video" onClick={onFechar}>
            <XIcon size={15} />
          </IconButton>
        </div>

        {/*
          * "Assistir com a sala".
          *
          * É o botão que fecha o fluxo: ele lê a página que a pessoa está vendo
          * dentro da view e vira item da fila. Fica desabilitado fora de uma
          * página de título — a URL da home não identifica um filme, e adicionar
          * isso à fila mostraria a mesma coisa para todo mundo da sala.
          */}
        {onAssistirComSala && (
          <Button
            onClick={() => pagina && onAssistirComSala(pagina.url, pagina.titulo || 'Título do Prime Video')}
            disabled={!naPaginaDeTitulo}
            className="h-9 w-full justify-center"
          >
            {naPaginaDeTitulo
              ? `Assistir com a sala: ${(pagina?.titulo || '').slice(0, 60)}`
              : 'Assistir com a sala'}
          </Button>
        )}

        {podeTocarProtegido === false && (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Este build do aplicativo não reproduz vídeo protegido dentro dele. Cada pessoa
            assiste no próprio Prime Video — no navegador, na conta dela.
          </p>
        )}

        {children}
      </div>
    </div>
  );
}

/** Modo navegação: o Prime aberto pelo card, sem item na fila. */
export function PrimeViewport({ onFechar, onAssistirComSala }: Pick<FaixaProps, 'onFechar' | 'onAssistirComSala'>) {
  return <PrimeBase onFechar={onFechar} onAssistirComSala={onAssistirComSala} />;
}

interface StageProps {
  item: { id: string; title: string; primeUrl?: string };
  readiness: Readiness | null;
  users: User[];
  meId: string | undefined;
  canControl: boolean;
  onReady: (ready: boolean) => void;
  onCountdown: () => void;
  onResync: () => void;
  onFechar: () => void;
}

/** Modo reprodução: há um item `prime` tocando, e a fila é a que coordena. */
export function PrimeStage({
  item,
  readiness,
  users,
  meId,
  canControl,
  onReady,
  onCountdown,
  onResync,
  onFechar,
}: StageProps) {
  const jaPronto = readiness?.userIds.includes(meId ?? '') ?? false;
  const faltam = users.filter((u) => u.connected && !readiness?.userIds.includes(u.userId));
  const prontos = readiness?.userIds.length ?? 0;
  const naSala = users.filter((u) => u.connected).length;

  return (
    <PrimeBase
      tituloDaFaixa={item.title}
      urlDaFaixa={item.primeUrl}
      onFechar={onFechar}
    >
      {/*
        * Prontidão: o que substitui a sincronização de player aqui.
        *
        * ## Por que não é play/pause sincronizado
        *
        * A pergunta foi pesquisa, não presumida:
        *
        * - As APIs oficiais da Prime Video (Video Central) são Content API, para
        *   parceiros de *conteúdo* enviarem catálogo, e Analytics API, somente
        *   leitura, para parceiros elegíveis. Nenhuma expõe reprodução, posição,
        *   ou controle sobre o player de um assinante.
        * - A Watch Party nativa da Amazon foi lançada em 2020 e **removida em
        *   2024**.
        * - Todo produto que promete sync (Teleparty, Prime Party, WatchNest) é
        *   extensão de navegador, e funciona injetando na página: lendo
        *   `video.currentTime` e chamando `play()` num contexto que o site não
        *   expõe.
        *
        * A última é a que decide. Esta view é o site da Amazon — sem preload,
        * sem Node, em sandbox, sem `executeJavaScript` — e injetar para ler a
        * posição seria exatamente o que a integração recusa ser. É o único
        * lugar onde esse caminho seria possível, e é justamente onde ele não
        * pode ser usado.
        *
        * Então o que sobra é coordenação de sala de cinema: cada um abre o
        * título na conta própria, confirma, e a contagem começa junto. É menos
        * preciso que um play sincronizado, e é o único caminho que não depende
        * de ler algo que o Prime não expõe.
        */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onReady(!jaPronto)} variant={jaPronto ? 'ghost' : 'primary'} className="h-9 gap-1.5">
          <CheckCircleIcon size={15} weight={jaPronto ? 'fill' : 'regular'} />
          {jaPronto ? 'Estou pronto' : 'Avisar que estou pronto'}
        </Button>

        {readiness?.countdownAt != null && <ContagemRegressiva desde={readiness.countdownAt} />}

        {prontos > 0 && (
          <span className="text-2xs text-ink-faint">
            {prontos} de {naSala} prontos
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
    </PrimeBase>
  );
}

/**
 * A contagem 5, 4, 3, 2, 1.
 *
 * O número vem de `countdownAt`, que é do servidor — se cada cliente contasse do
 * seu relógio, duas máquinas com relógios diferentes começariam em instantes
 * diferentes, e a sala daria play fora de sincronia, que é exatamente o que a
 * contagem existe para evitar.
 *
 * Passado o tempo ela vira "já pode começar": um número travado em 1 é
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
