/**
 * Desenho do destaque de menção no chat.
 *
 * ## Por que o texto é lido de novo aqui
 *
 * O servidor já resolveu quem foi citado e mandou os `sessionId` na mensagem.
 * Este arquivo **não decide** nada disso — ele só procura no texto o que
 * aquele lado já decidiu, para desenhar em volta.
 *
 * A separação é o que impede a falha constrangida: se o cliente decidisse quem é
 * citado, bastaria adulterar o texto para mentionar alguém, e o efeito não seria
 * o highlight errado, seria som e notificação na máquina de quem não foi citado.
 *
 * ## Por que reimplementar o parser, e não importar o do servidor
 *
 * `web` não importa nada de `server/`: o servidor é o backend e o front é
 * empacotado separado, exatamente como o `desktop` é separado da `web`. Trazer o
 * parser exigiria um pacote compartilhado e um passo de build a mais.
 *
 * O custo de ter as duas cópias é que elas precisam concordar — e por isso o
 * teste `mencoes.test.ts` roda o **servidor** e compara com o que o cliente faz
 * no mesmo texto. A alternativa, o cliente fazendo parsing diferente sem ninguém
 * perceber, é a origem clássica de "no meu navegador o destaque não aparece".
 */

export interface AlvoDestaque {
  sessionId: string;
  name: string;
}

/** Um pedaço do texto: literal, ou menção a desenhar. */
export type Segmento =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'mencao'; texto: string; nome: string; sessionId: string };

const MAX_MENCAO = 40;

/**
 * Forma normalizada de comparação.
 *
 * Tem de ser idêntica à do servidor, caractere por caractere: o `NFD` separa o
 * acento do caractere base, o `NFC` volta a compor, e o `̀-ͯ` é o bloco de
 * marcas combinantes. Um `\p{M}` aqui resolveria o mesmo caso e seria mais
 * legível, mas muda o conjunto para o navegador decidir — e navegador
 * diferente, conjunto diferente.
 */
export function normalizar(nome: string): string {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const NOME_CURTO = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9_.\- ]*$/;

/** Acrescenta um `sessionId` à lista da chave, sem repetir. */
function empurra(mapa: Map<string, string[]>, chave: string, sessionId: string): void {
  const atual = mapa.get(chave);
  if (atual) {
    if (!atual.includes(sessionId)) atual.push(sessionId);
  } else {
    mapa.set(chave, [sessionId]);
  }
}

/**
 * Divide o texto em pedaços, marcando as menções.
 *
 * `mencionados` é a lista de `sessionId` que veio do servidor. O desenho usa
 * **só** esses ids: um `@nome` que está no texto mas não foi citado não é
 * desenhado, porque isso significaria que o parser do cliente discordou do
 * servidor, e a resposta certa é não desenhar nada — não é desenhar errado.
 */
export function segmentarTexto(
  texto: string,
  participantes: readonly AlvoDestaque[],
  mencionados: readonly string[],
): Segmento[] {
  const fonte = String(texto ?? '');
  if (!fonte || mencionados.length === 0) return [{ tipo: 'texto', texto: fonte }];

  /*
   * Índice do nome completo e o do **primeiro nome**, para `@Maria` citar
   * `Maria Silva`.
   *
   * Dois índices em vez de um só, porque o completo tem precedência e o de
   * primeiro nome é o plano B do mesmo candidato. A ordem entre eles tem de ser
   * a mesma do servidor: invertida, o desenho apontaria para a pessoa errada
   * justamente no caso de nome composto, que é onde o `@` é ambíguo.
   */
  const nomes = new Map<string, string[]>();
  const primeiros = new Map<string, string[]>();
  for (const p of participantes) {
    const completo = normalizar(p.name);
    if (completo) empurra(nomes, completo, p.sessionId);
    const corte = completo.indexOf(' ');
    if (corte > 0) empurra(primeiros, completo.slice(0, corte), p.sessionId);
  }
  const citados = new Set(mencionados);

  const saida: Segmento[] = [];
  let cursor = 0;

  for (let i = 0; i < fonte.length; i++) {
    if (fonte[i] !== '@') continue;
    if (i > 0 && /[\wÀ-ÿ]/.test(fonte[i - 1])) continue;

    const inicio = i + 1;
    let fim = inicio;
    while (fim < fonte.length && NOME_CURTO.test(fonte[fim]) && fim - inicio < MAX_MENCAO) fim++;

    /*
     * O **maior** casamento, sem interromper no primeiro.
     *
     * Com `Maria Silva` e `maria` na sala, `@Maria Silva` casa com as duas
     * possibilidades, e quem escreveu o nome inteiro quer dizer a pessoa do nome
     * inteiro. Interromper no primeiro acerto citava a pessoa errada.
     */
    let melhores: { sessionId: string; texto: string; fim: number } | null = null;
    let p = inicio;
    while (p < fim) {
      let prox = p;
      while (prox < fim && fonte[prox] !== ' ') prox++;
      /*
       * O candidato é o trecho **desde o `@`**, e não só a palavra atual. Sem
       * isto, `@Maria Silva` testaria "Maria" e "Silva" e nunca casaria com o
       * nome completo — e o desenho marcaria metade do nome.
       */
      const candidato = fonte.slice(inicio, prox);
      if (candidato.length > 0) {
        const chave = normalizar(candidato);
        const sessionIds = nomes.get(chave) ?? primeiros.get(chave);
        if (sessionIds) {
          // Com nomes repetidos, o primeiro id citado é o que o desenho
          // representa: os dois apontam para o mesmo `@nome` na tela, e é o
          // texto que importa, não a pessoa.
          const alvo = sessionIds.find((id) => citados.has(id));
          if (alvo) melhores = { sessionId: alvo, texto: candidato, fim: prox };
        }
      }
      p = prox + 1;
    }

    if (!melhores) continue;

    if (i > cursor) saida.push({ tipo: 'texto', texto: fonte.slice(cursor, i) });
    saida.push({ tipo: 'mencao', texto: fonte.slice(i, melhores.fim), nome: melhores.texto, sessionId: melhores.sessionId });
    cursor = melhores.fim;
    i = melhores.fim - 1;
  }

  if (cursor < fonte.length) saida.push({ tipo: 'texto', texto: fonte.slice(cursor) });
  return saida.length > 0 ? saida : [{ tipo: 'texto', texto: fonte }];
}

/**
 * O `@` que está sendo digitado agora, para o autocomplete.
 *
 * Mesmas regras do servidor: só o `@` que não está no meio de outra palavra, e
 * só enquanto o que vem depois é nome — `@Maria olá` já é frase, não convite.
 */
export function mencaoPendente(antesDoCursor: string): { inicio: number; consulta: string } | null {
  const fonte = String(antesDoCursor ?? '');
  const at = fonte.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && /[\wÀ-ÿ]/.test(fonte[at - 1])) return null;

  const parcial = fonte.slice(at + 1);
  if (parcial.length > MAX_MENCAO) return null;
  if (/[\n\r,.;:!?()[\]{}"'`]/.test(parcial)) return null;
  if (!NOME_CURTO.test(parcial)) return null;
  return { inicio: at, consulta: parcial };
}

/**
 * Participantes que casam com o que está sendo digitado, para a lista.
 *
 * Genérica no tipo do participante, e não devolvendo `AlvoDestaque`: a lista do
 * autocomplete precisa do `User` inteiro, porque cada item desenha avatar, cor e
 * nome a partir dele. Devolver o tipo mínimo obrigaria a converter de volta na
 * página — e a conversão perderia o campo que faltasse, que é exatamente o
 * tipo de bug que só aparece quando alguém entra na sala com foto.
 */
export function sugerir<T extends AlvoDestaque>(
  consulta: string,
  participantes: readonly T[],
): T[] {
  const alvo = normalizar(consulta);
  if (!alvo) return [];
  return participantes
    .filter((p) => normalizar(p.name).startsWith(alvo))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
