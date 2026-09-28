'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { tocarSomDeMencao } from '@/lib/mentionSound';
import {
  jaPediuPermissaoDeNotificacao,
  lerPreferencias,
  marcarPermissaoPedida,
  gravarPreferencias,
  PADRAO_MENCAO,
  type PreferenciasMencao,
} from '@/lib/mentionPreferences';
import { desktop, isDesktop } from '@/lib/desktop';
import { registrarPush, removerPush } from '@/lib/push';

/**
 * Menção recebida: o que o servidor mandou só para esta pessoa.
 *
 * É este evento — e não a mensagem do chat — que dispara som, notificação e
 * destaque. A mensagem vai para a sala inteira e carrega a lista de citados, e
 * isso serve para o **desenho**; se o som saísse de lá, toda a sala ouviria o
 * nome de cada pessoa mencionada, e o `@` deixaria de ser sinal e viraria
 * alarme.
 */
export interface EventoMencao {
  messageId: string;
  fromName: string;
  fromColor: string;
  fromSessionId: string;
  texto: string;
  preview: string;
  at: number;
}

interface Opcoes {
  /** `sessionId` de quem está olhando, para não reagir à própria menção. */
  meuSessionId: string | null | undefined;
  /**
   * `userId` de quem está olhando, para registrar o endereço de push.
   *
   * É o `userId` e não o `sessionId` porque o endereço fica guardado no servidor
   * por `userId` — ver `pages/room/[id].tsx`.
   */
  meuUserId: string | null | undefined;
  /** Chamado a cada menção aceita, para o chat poder piscar. */
  aoChamarAtencao?: (evento: EventoMencao) => void;
  /** Chamado quando o clique na notificação do sistema acontece. */
  aoAbrirChat?: () => void;
}

/**
 * As três camadas de aviso de uma menção, e o porquê de cada uma existir.
 *
 * A ordem importa, e é a ordem do incômodo crescente: som é o mais discreto,
 * notificação do sistema é o que tira a pessoa de outro programa, e "não
 * perturbe" corta as três. Nenhuma delas é obrigatória para a menção fazer o
 * que importa — o `@nome` no texto já está lá para quem lê.
 */
export function useMencoes({ meuSessionId, meuUserId, aoChamarAtencao, aoAbrirChat }: Opcoes) {
  const [prefs, setPrefs] = useState<PreferenciasMencao>(PADRAO_MENCAO);
  /**
   * Se este navegador tem endereço de push registrado.
   *
   * Não é o mesmo que a preferência estar ligada: a preferência é o que a pessoa
   * pediu, e isto é o que o servidor confirmou. Servidor sem chaves VAPID
   * responde 503 e a inscrição não acontece, e a diferença entre os dois é
   * justamente o que impede o botão de prometer um aviso que ninguém envia.
   */
  const [pushAtivo, setPushAtivo] = useState(false);
  /** As preferências já vieram do `localStorage`, e não são mais o padrão. */
  const [pronto, setPronto] = useState(false);
  /**
   * Menções que chegaram e ainda não foram vistas, e a última delas.
   *
   * O par vai junto porque o contador sozinho não serve para nada: um "(3)" na
   * aba não diz *quem* chamou, e quem foi chamado quer saber quem foi. A última
   * menção é o que o aviso dentro do app mostra.
   */
  const [naoLidas, setNaoLidas] = useState<{ total: number; ultima: EventoMencao | null }>({
    total: 0,
    ultima: null,
  });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const abrirChatRef = useRef(aoAbrirChat);
  abrirChatRef.current = aoAbrirChat;
  const atencaoRef = useRef(aoChamarAtencao);
  atencaoRef.current = aoChamarAtencao;

  /*
   * Lê as preferências depois da montagem, e não no `useState` inicial: o
   * `localStorage` não existe durante o SSR do Next, e ler no inicial daria
   * "só no servidor" e apagaria a escolha da pessoa no primeiro render no
   * navegador.
   *
   * O `pronto` é o que impede a inscrição de push de rodar com a preferência
   * padrão. `PADRAO_MENCAO` tem `notificacoes: true`, e sem esta trava quem
   * desligou as notificações veria o site **registrar e cancelar** o endereço a
   * cada carregamento: primeiro o efeito-age com o padrão ligado, e só depois o
   * `lerPreferencias` traria a escolha real e o efeito desligaria. Duas chamadas
   * ao servidor em toda abertura de sala, para terminar exatamente onde começou.
   */
  useEffect(() => {
    setPrefs(lerPreferencias());
    setPronto(true);
  }, []);

  const atualizarPrefs = useCallback((nova: Partial<PreferenciasMencao>) => {
    setPrefs((atual) => {
      const seguinte = { ...atual, ...nova };
      gravarPreferencias(seguinte);
      return seguinte;
    });
  }, []);

  /**
   * Pede a permissão de notificação.
   *
   * Só pode ser chamada a partir de um gesto da pessoa, e o único gesto possível
   * é ela mexer no botão. Por isso o pedido mora aqui e não no mount: pedir
   * permissão sozinho é garantido receber "denied" nos navegadores que exigem
   * gesto, e aí o botão ficaria ligado sem nunca notificar.
   *
   * Se o pedido sair negado, a preferência volta para desligada — porque deixar
   * "notificações: ligado" com a permissão negada é um botão que mente sobre o
   * que está fazendo.
   */
  const pedirPermissao = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      atualizarPrefs({ notificacoes: false });
      return false;
    }
    marcarPermissaoPedida();
    if (Notification.permission === 'granted') {
      atualizarPrefs({ notificacoes: true });
      return true;
    }
    if (Notification.permission === 'denied') {
      atualizarPrefs({ notificacoes: false });
      return false;
    }
    try {
      const resposta = await Notification.requestPermission();
      atualizarPrefs({ notificacoes: resposta === 'granted' });
      return resposta === 'granted';
    } catch {
      atualizarPrefs({ notificacoes: false });
      return false;
    }
  }, [atualizarPrefs]);

  /*
   * A inscrição em push acompanha a preferência de notificação.
   *
   * ## Por que o efeito e não o botão
   *
   * Registrar no clique do botão funciona na primeira vez e quebra na segunda:
   * quem já tinha permitido notificações no passado nunca mais passa pelo botão,
   * e ficaria sem a única camada que alcança quem está com o site fechado.
   *
   * Ligar e desligar a preferência é o que a pessoa controla de verdade, então é
   * aí que a inscrição acompanha. O efeito só age quando o valor **muda** — sem
   * essa guarda, ele reinscreveria a cada render e o `subscribe` do navegador
   * devolveria o mesmo endereço sem parar.
   *
   * A inscrição **não** pode acontecer no Electron: lá quem notifica é o processo
   * principal, e o `Notification` do Chromium não sobrevive ao app fechado. Um
   * endereço de push registrado aqui nunca receberia nada, e o servidor pagaria
   * uma chamada que falha em toda menção.
   */
  useEffect(() => {
    if (!pronto) return;
    if (!meuUserId) return;
    if (isDesktop()) return;

    let cancelado = false;

    if (prefs.notificacoes) {
      if (Notification.permission !== 'granted') return;
      void registrarPush(meuUserId).then((ok) => {
        if (ok && !cancelado) setPushAtivo(true);
      });
    } else {
      void removerPush(meuUserId).then(() => {
        if (!cancelado) setPushAtivo(false);
      });
    }

    return () => {
      cancelado = true;
    };
  }, [pronto, prefs.notificacoes, meuUserId]);

  /*
   * Processa uma menção recebida.
   *
   * Separada do efeito de propósito: é o que permite ao socket ligar direto
   * nela, sem o efeito depender do objeto inteiro e recriar a cada render.
   */
  const tratar = useCallback((evento: EventoMencao) => {
    if (!evento) return;
    // Citar a si mesmo não existe do lado do servidor, mas um cliente
    // adulterado pode mandar: o som do próprio nome é só ruído.
    if (meuSessionId && evento.fromSessionId === meuSessionId) return;

    const { som, notificacoes, naoPerturbe } = prefsRef.current;

    if (!naoPerturbe) {
      if (som) tocarSomDeMencao();
      atencaoRef.current?.(evento);
    }

    /*
     * A menção é registrada sempre, perturbando ou não.
     *
     * A contagem é o que alimenta o `(n)` no título da aba e o aviso dentro do
     * app — e o aviso dentro do app é a camada de que mais se pode confiar,
     * porque não depende de o navegador decidir mostrar notificação. Com "não
     * perturbe" ela perde o som e a notificação, mas continua sabendo que foi
     * chamada; sem isto, a opção vira "não me avise", e aí a menção é conteúdo
     * e não sinal.
     */
    setNaoLidas((atual) => ({ total: atual.total + 1, ultima: evento }));

    /*
     * Notificação do sistema, só com a aba escondida.
     *
     * Com a aba à frente, a pessoa está lendo: uma notificação do sistema
     * aparecendo por cima da janela que ela está usando é puro ruído. E no
     * desktop isso nem é caminho — quem notifica é o processo principal, com
     * `flashFrame`, que por sua vez só age fora do foco.
     */
    const escondido = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!notificacoes || !escondido) return;

    const titulo = `${evento.fromName} te mencionou`;
    const corpo = evento.preview || `@${evento.texto}`;

    const app = desktop();
    if (app) {
      void app.notifyMention(titulo, corpo).catch(() => undefined);
      return;
    }
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      /*
       * O `icon` é explícito porque, sem ele, o Chrome usa o favicon da página —
       * que no Juntos é o logo do app, e numa notificação de "fulano te
       * mencionou" parece o próprio fulano falando. Um ícone de menção lê
       * diferente de um ícone do site.
       *
       * O `tag` é o id da mensagem: duas menções da mesma mensagem não
       * empilham dois avisos, e a segunda substitui a primeira em vez de
       * empurrar a anterior para fora da tela.
       *
       * ## Sem `silent: true`
       *
       * A notificação do sistema era muda, e com a aba em segundo plano a
       * menção não fazia barulho nenhum. Quem está vendo o vídeo em tela cheia
       * numa aba de fundo não vê o aviso, não vê o número na aba e não ouve o
       * som: era o pior dos casos, onde a menção existe e não chega a ninguém.
       *
       * O som continua sendo do app quando a aba está em foco, porque ali o
       * `tocarSomDeMencao` é o que dá a identidade da menção. Aqui a notificação
       * assume o som do navegador, e é isso que a pessoa ouve longe do teclado.
       */
      const n = new Notification(titulo, {
        body: corpo,
        tag: `mencao-${evento.messageId}`,
        icon: '/mention-48x48.png',
        badge: '/favicon.ico',
      });
      n.onclick = () => {
        window.focus();
        abrirChatRef.current?.();
        n.close();
      };
    } catch {
      // Navegador sem suporte real à notificação: o som e o destaque do chat já
      // saíram, e perder a terceira camada não pode ser erro.
    }
  }, [meuSessionId]);

  return {
    prefs,
    atualizarPrefs,
    pedirPermissao,
    tratar,
    /** Quantas menções chegaram, e a última delas. */
    mencoesNaoLidas: naoLidas.total,
    ultimaMencao: naoLidas.ultima,
    limparNaoLidas: useCallback(() => setNaoLidas({ total: 0, ultima: null }), []),
    jaPediuPermissao: typeof window !== 'undefined' && jaPediuPermissaoDeNotificacao(),
    /**
     * Se o aviso com o site fechado está de fato registrado.
     *
     * A UI usa isto para não prometer o que não está ligado: num servidor sem
     * chaves VAPID a inscrição falha, e um rótulo dizendo "notifica mesmo com o
     * site fechado" seria mentira.
     */
    pushAtivo,
  };
}