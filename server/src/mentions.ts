/**
 * Menções `@nome` do chat.
 *
 * ## Onde fica a autoridade
 *
 * Aqui, e não no cliente. O cliente manda texto; quem decide se aquele texto
 * menciona alguém é o servidor, porque é ele que sabe quem está na sala agora.
 * Se o cliente decidisse, bastaria um `console` para mentionar quem não está na
 * sala — e o efeito colateral não seria o Warehouse de texto, seria o som e a
 * notificação na máquina de quem foi citado.
 *
 * Por isso o parsing é feito duas vezes, de propósito:
 *
 * - aqui, para decidir **quem** é notificado, e só a pessoa citada;
 * - no cliente, para **desenhar** o destaque. O cliente não decide quem é
 *   mencionado, ele só procura no texto o que o servidor já decidiu.
 *
 * ## Por que o nome é a chave, e o `sessionId` é o alvo
 *
 * Não existe id "@" estável: a pessoa digita `@Maria`, e a chave é o nome. A
 * ambiguidade é real — duas pessoas com o mesmo nome na mesma sala — e ela é
 * resolvida do jeito menos ruim possível: as duas são citadas. Notificar uma
 * pessoa errada é pior do que notificar as duas, porque quem recebe uma menção
 * que não era para ela para de confiar na que era.
 *
 * Depois do nome, o alvo é o `sessionId`, que é o que permite entregar só para a
 * pessoa citada.
 *
 * ## Acento e caixa
 *
 * `@maria` cita quem se chama `Maria`, e `@Maria` também. Digitar acento num
 * teclado sem acento é o caminho comum, e uma menção que não encontra a pessoa
 * é pior do que uma que encontra. A comparação é feita sobre a forma
 * normalizada, e o destaque devolve o texto **como a pessoa digitou** — o
 *Highlight nunca reescreve a mensagem de quem escreveu.
 */

/** Caracteres aceitos dentro de um nome digitado depois do `@`. */
const NOME_CURTO = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9_.\- ]*$/;

/** Teto de caracteres para uma menção. Ninguém tem nome de 200 letras. */
const MAX_MENCAO = 40;

/** Participante mínimo para a resolução de menções. */
export interface MencaoAlvo {
  sessionId: string;
  name: string;
}

/**
 * Uma menção resolvida.
 *
 * `inicio`/`fim` delimitam o **nome** no texto original, sem o `@` — é o que o
 * cliente usa para desenhar o destaque em volta de `@Maria` e não de `@Maria
 * olá`. E `texto` é o que a pessoa digitou, nunca o nome oficial: reescrever a
 * mensagem alheia é pior do que o destaque ficar levemente torto.
 */
export interface Mencao {
  sessionId: string;
  texto: string;
  inicio: number;
  fim: number;
}

/**
 * Forma normalizada de comparação: sem acento, sem caixa, espaços colapsados.
 *
 * `NFD` separa o acento do caractere base e o `NFC` volta a compor — é o
 * caminho padrão para isso, e o que faz `@joao` achar `João` e `@JoAo` achar
 * `joão`.
 */
export function normalizarNome(nome: string): string {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Índice do nome normalizado para **todos** que o têm.
 *
 * O valor é uma lista, e não um `sessionId` só, por causa da ambiguidade de
 * nomes repetidos: um `Map<string, string>` guardaria o último e a outra pessoa
 * nunca seria citada. Com a lista, as duas são — que é a decisão escrita no
 * cabeçalho deste arquivo, e ela só funciona se o índice realmente guardar as
 * duas.
 */
function indicePorNome(participantes: readonly MencaoAlvo[]): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  for (const p of participantes) {
    const chave = normalizarNome(p.name);
    if (!chave) continue;
    const atual = mapa.get(chave);
    if (atual) {
      if (!atual.includes(p.sessionId)) atual.push(p.sessionId);
    } else {
      mapa.set(chave, [p.sessionId]);
    }
  }
  return mapa;
}

/**
 * Índice do **primeiro nome**, para `@Maria` citar `Maria Silva`.
 *
 * É o que a pessoa espera ao digitar o primeiro nome de alguém, e sem isto a
 * única forma de citar um nome composto seria escrever o nome inteiro. Com o
 * índice separado do nome completo, a preferência continua sendo pelo mais longo
 * — o índice do primeiro nome só é consultado quando o completo não casou.
 *
 * Só entra quem tem nome com espaço. `Bob` vira índice de primeiro nome e de
 * nome completo ao mesmo tempo, e aí os dois índices duplicariam o resultado
 * sem ganhar nada.
 */
function indicePorPrimeiroNome(participantes: readonly MencaoAlvo[]): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  for (const p of participantes) {
    const completo = normalizarNome(p.name);
    const corte = completo.indexOf(' ');
    if (corte <= 0) continue;
    const primeiro = completo.slice(0, corte);
    const atual = mapa.get(primeiro);
    if (atual) {
      if (!atual.includes(p.sessionId)) atual.push(p.sessionId);
    } else {
      mapa.set(primeiro, [p.sessionId]);
    }
  }
  return mapa;
}

/**
 * Encontra as menções de um texto e resolve para quem elas são.
 *
 * ## O algoritmo, e por que acumula palavras
 *
 * Nomes têm espaço. `Maria Silva` digitado como `@Maria Silva` precisa casar, e
 * `@Maria` também precisa casar com alguém que se chama `Maria Silva` — é o que
 * a pessoa espera ao digitar o primeiro nome. Então, a partir de cada `@`, o
 * texto é partido em palavras e acumular **uma a uma**, testando o candidato
 * acumulado contra os nomes da sala, e o **maior** que casar ganha.
 *
 * Avaresso e predizível: a partir de um `@`, no máximo o número de palavras até
 * a próxima pontuação é testado, e o tamanho da sala só pesa no número de
 * comparações, que é um `Map`.
 *
 * ## Casamento por palavra, não por prefixo solto
 *
 * `@Mariaxyz` não cita `Maria`. O acumulado só é aceito no fim de uma palavra
 * completa, o que também evita que `@Mar` case com `Marcelo` — para isso a
 * pessoa escreve `@Marcel`.
 */
export function extrairMencoes(
  texto: string,
  participantes: readonly MencaoAlvo[],
): Mencao[] {
  const nomes = indicePorNome(participantes);
  const primeiros = indicePorPrimeiroNome(participantes);
  if (nomes.size === 0) return [];

  const fonte = String(texto ?? '');
  const achados: Mencao[] = [];
  const vistos = new Set<string>();

  for (let i = 0; i < fonte.length; i++) {
    if (fonte[i] !== '@') continue;
    // Um e-mail no meio do texto não é menção: `alguem@exemplo.com` não
    // deveria notificar quem se chama `exemplo`. A regra é o mesmo do e-mail —
    // o caractere anterior não pode ser parte de uma palavra.
    if (i > 0 && /[\wÀ-ÿ]/.test(fonte[i - 1])) continue;

    const inicio = i + 1;
    // Janela de leitura: a partir do `@`, enquanto o caractere for de nome.
    let fim = inicio;
    while (fim < fonte.length && NOME_CURTO.test(fonte[fim]) && fim - inicio < MAX_MENCAO) {
      fim++;
    }

    /*
     * Acumula palavra a palavra e guarda o **maior** casamento.
     *
     * "Maior" é a palavra que faz a diferença, e há um caso que prova: na sala
     * estão `Maria Silva` e `maria`. Em `@Maria Silva olha`, o candidato de uma
     * palavra casa com `maria` e o de duas casa com `Maria Silva`. Ganha o de
     * duas — quem escreveu o nome inteiro quer dizer a pessoa do nome inteiro.
     *
     * Por isso isto **não** interrompe no primeiro acerto. A primeira versão
     * interrompia, e `@Maria Silva` citava a pessoa chamada `maria`: som e
     * notificação para a pessoa errada, sem nenhum erro visível.
     */
    let melhores: { sessionIds: string[]; texto: string; fim: number } | null = null;
    let cursor = inicio;
    while (cursor < fim) {
      // Anda até o fim da próxima palavra (inclui o espaço final, se houver).
      let prox = cursor;
      while (prox < fim && fonte[prox] !== ' ') prox++;
      /*
       * O candidato é o trecho **desde o `@`**, e não só a palavra atual.
       *
       * Sem isto, `@Maria Silva` testaria "Maria" e depois "Silva" — nunca
       * "Maria Silva" — e o nome composto não casaria com nada. É a diferença
       * entre "acumula palavra a palavra" e "olha uma palavra por vez", e as
       * duas coisas parecem a mesma coisa lendo o código.
       */
      const candidato = fonte.slice(inicio, prox);
      if (candidato.length > 0) {
        // Nome completo tem precedência sobre primeiro nome, para o mesmo
        // candidato: `@Maria` procura "maria" e "maria silva" nessa ordem, e
        // `@Maria Silva` vai acumulando até casar com o completo.
        const chave = normalizarNome(candidato);
        const sessionIds = nomes.get(chave) ?? primeiros.get(chave);
        if (sessionIds && sessionIds.length > 0) {
          melhores = { sessionIds, texto: candidato, fim: prox };
        }
      }
      cursor = prox + 1;
    }

    if (!melhores) continue;
    for (const sessionId of melhores.sessionIds) {
      if (vistos.has(sessionId)) continue;
      vistos.add(sessionId);
      achados.push({ sessionId, texto: melhores.texto, inicio, fim: melhores.fim });
    }
  }

  return achados;
}

/**
 * Que `@` está sendo digitado agora, para o autocomplete.
 *
 * Devolve o índice do `@` e o texto parcial, ou `null`. O autocomplete é um
 * recurso do cliente, então isto roda lá — mas a **decisão** de quem é
 * mencionado continua sendo do servidor. Esta função é só para desenhar a
 * lista de sugestões.
 *
 * Só considera o `@` que estiver depois da última quebra de linha, e apenas se
 * não houver nada entre ele e o cursor além de nome: `@Maria olá` não é
 * autocomplete, é texto.
 */
export function mencaoPendente(antesDoCursor: string): { inicio: number; consulta: string } | null {
  const fonte = String(antesDoCursor ?? '');
  const at = fonte.lastIndexOf('@');
  if (at === -1) return null;
  // Um `@` colado no meio de outra palavra é parte do texto, não um convite.
  if (at > 0 && /[\wÀ-ÿ]/.test(fonte[at - 1])) return null;

  const parcial = fonte.slice(at + 1);
  if (parcial.length > MAX_MENCAO) return null;
  // Quebrou a linha, ou tem pontuação: o `@` já era texto.
  if (/[\n\r,.;:!?()[\]{}"'`]/.test(parcial)) return null;
  if (!NOME_CURTO.test(parcial)) return null;
  return { inicio: at, consulta: parcial };
}

/** Participantes que casam com o que está sendo digitado, para a lista. */
export function sugerirMencoes(
  consulta: string,
  participantes: readonly MencaoAlvo[],
): MencaoAlvo[] {
  const alvo = normalizarNome(consulta);
  if (!alvo) return [];
  return participantes
    .filter((p) => normalizarNome(p.name).startsWith(alvo))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
