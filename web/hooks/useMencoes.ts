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
import { desktop } from '@/lib/desktop';

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
export function useMencoes({ meuSessionId, aoChamarAtencao, aoAbrirChat }: Opcoes) {
  const [prefs, setPrefs] = useState<PreferenciasMencao>(PADRAO_MENCAO);
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
   */
  useEffect(() => {
    setPrefs(lerPreferencias());
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

  /**
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
       */
      const n = new Notification(titulo, {
        body: corpo,
        tag: `mencao-${evento.messageId}`,
        icon: '/mention-48x48.png',
        badge: '/favicon.ico',
        silent: true,
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
  };
}