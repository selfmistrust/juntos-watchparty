/**
 * Preferências de menção, por pessoa, no `localStorage`.
 *
 * ## O padrão, e por que som e notificação começam ligados
 *
 * Ligados. A menção é o único evento do app que chega de outra pessoa dizendo
 * "olha isso aqui" — a função dela é ser imediata, e uma notificação desligada
 * por padrão é uma menção que não chega.
 *
 * Só que "ligado por padrão" e "pedir permissão por padrão" são coisas
 * diferentes, e a segunda é o que a plataforma exige: a `Notification` só pode
 * ser pedida a partir de um gesto da pessoa. A chave por trás disto é
 * `pediuPermissao` — sem ela, o app não sabe se já tentou e o botão fica
 * mentindo sobre o estado.
 *
 * ## "Não perturbe" é o interruptor geral
 *
 * Não é o mesmo que desligar os dois, e a diferença importa no caminho. Desligar
 * som e notificação deixa as duas camadas desligadas; "não perturbe" desliga
 * também o **aviso no chat** e o destaque na aba, porque o incômodo de ser
 * chamado não é só o som, é a tela piscando. Quem está vendo o vídeo não quer
 * nada disso.
 *
 * E o destaque do `@nome` na mensagem continua sempre: aquele é conteúdo, não
 * perturbação. A pessoa lê o nome na conversa de qualquer jeito.
 */

export interface PreferenciasMencao {
  /** Som curto de atenção. */
  som: boolean;
  /** Notificação do sistema, só quando a aba está em segundo plano. */
  notificacoes: boolean;
  /** Aviso no chat e destaque da aba. */
  naoPerturbe: boolean;
}

export const PADRAO_MENCAO: PreferenciasMencao = {
  som: true,
  notificacoes: true,
  naoPerturbe: false,
};

const CHAVE = 'juntos:mencao:pref';

/**
 * Lê as preferências, tolerando storage indisponível.
 *
 * Modo privado restrito e contexto bloqueado lançam em `localStorage`, e uma
 * exceção aqui derrubaria a página inteira no `useState` inicial do hook. O
 * pior caso de não conseguir ler é ficar no padrão — que é o que a pessoa
 * escolheu da última vez, ou o padrão de fábrica.
 */
export function lerPreferencias(): PreferenciasMencao {
  if (typeof window === 'undefined') return PADRAO_MENCAO;
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (!bruto) return PADRAO_MENCAO;
    const salvo = JSON.parse(bruto) as Partial<PreferenciasMencao>;
    return {
      // Cada campo é conferido isoladamente: um `localStorage` editado à mão,
      // ou de uma versão anterior do formato, não pode virar `undefined` no
      // meio de uma comparação.
      som: salvo.som === undefined ? PADRAO_MENCAO.som : Boolean(salvo.som),
      notificacoes:
        salvo.notificacoes === undefined
          ? PADRAO_MENCAO.notificacoes
          : Boolean(salvo.notificacoes),
      naoPerturbe:
        salvo.naoPerturbe === undefined
          ? PADRAO_MENCAO.naoPerturbe
          : Boolean(salvo.naoPerturbe),
    };
  } catch {
    return PADRAO_MENCAO;
  }
}

export function gravarPreferencias(pref: PreferenciasMencao): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(pref));
  } catch {
    // Sem storage, a preferência vale só para esta aba. Perder a persistência é
    // bem menos ruim do que impedir a pessoa de desligar o som.
  }
}

const CHAVE_PERMISSAO = 'juntos:mencao:pediuPermissao';

export function jaPediuPermissaoDeNotificacao(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CHAVE_PERMISSAO) === '1';
  } catch {
    return false;
  }
}

export function marcarPermissaoPedida(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAVE_PERMISSAO, '1');
  } catch {
    // Sem registro, o botão pode perguntar de novo. Melhor perguntar duas vezes
    // do que travar a interface num estado que não sai.
  }
}
