import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O título da aba não pode acumular prefixo.
 *
 * ## O defeito que este arquivo existe para impedir
 *
 * O título piscava assim:
 *
 *     const original = document.title;
 *     if (!original.includes('•')) document.title = `(${n}) ${original}`;
 *
 * Três erros na mesma linha. A base era lida **depois** de já ter escrito nele,
 * então cada menção acrescentava um `(0)` ao título já adulterado — a captura de
 * tela mostrou `(0) (0) (0) (0) junto`. E escrevia mesmo com o contador em zero,
 * porque o `return` que protegia isso vinha uma linha depois. E a guarda do `•`
 * não segurava nada, porque nada escrevia `•`.
 *
 * ## Por que testar a forma do código
 *
 * A conta de quantos `(n)` cabem é a mesma em qualquer navegador, e um teste que
 * precisasse de `document` real só rodaria em navegador. O que dá para travar
 * aqui é a **ordem**: base capturada antes de escrever, e nada escrito quando o
 * contador é zero. São as duas condições que, juntas, impedem o acúmulo.
 */
const pagina = readFileSync(
  resolve(process.cwd(), '../web/pages/room/[id].tsx'),
  'utf8',
);
const hook = readFileSync(
  resolve(process.cwd(), '../web/hooks/useMencoes.ts'),
  'utf8',
);

test('a base do titulo e capturada uma vez, antes de escrever', () => {
  /*
   * A ref é o que quebra o ciclo. Sem ela, "a base" seria `document.title` lido
   * no momento do efeito — e o valor lido já seria o título modificado, que é
   * exatamente o defeito.
   */
  assert.match(
    pagina,
    /const tituloBase = useRef<string \| null>\(null\)/,
    'a base do titulo precisa ser uma ref',
  );
  assert.match(
    pagina,
    /tituloBase\.current === null[\s\S]{0,200}?document\.title/,
    'a base e lida do documento uma unica vez',
  );
});

test('o titulo so e reescrito a partir da base, nunca do titulo atual', () => {
  /*
   * A linha que faz o trabalho tem que usar `base`, e não `document.title`.
   * Usar `document.title` seria o defeito de novo, com outro nome.
   */
  const linhas = pagina
    .split('\n')
    .filter((l) => l.includes('document.title ='));
  assert.ok(linhas.length >= 2, 'escreve o titulo e o restaura na saída');
  for (const linha of linhas) {
    assert.ok(
      !/document\.title = `?\(/.test(linha) || linha.includes('base'),
      `esta linha escreve no titulo sem partir da base: ${linha.trim()}`,
    );
  }
  assert.match(
    pagina,
    /document\.title = naoLidas > 0 \? `\(\$\{naoLidas\}\) \$\{base\}` : base/,
    'o titulo e a base, ou a base com o contador na frente',
  );
});

test('nada e escrito quando o contador e zero', () => {
  /*
   * `(0) junto` e pior do que `junto`: uma pessoa que olha a aba e ve um zero
   * nao sabe se o app esta avisando alguma coisa ou so falhando.
   */
  assert.match(
    pagina,
    /naoLidas > 0 \?/,
    'o contador precisa de guarda — o ternario tem que ter o lado do zero',
  );
});

test('o contador e zerado ao abrir o chat', () => {
  /*
   * Sem isto, o `(3)` sobrevivia a ter lido tudo, e nao haveria como distinguir
   * novidade de residuo. E o titulo da aba mentindo sobre o estado e pior do
   * que nao ter titulo com contador.
   */
  /*
   * A janela é larga de propósito: entre o `useCallback` e a chamada há um bloco
   * de comentário explicando **por que** a limpeza vem por ref, e esse comentário
   * é parte do que o teste precisa atravessar. Uma janela curta faria o teste
   * passar só porque alguém encurtou a explicação.
   */
  assert.match(
    pagina,
    /const abrirChat = useCallback\(\(\) => \{[\s\S]{0,900}?limparNaoLidasRef\.current\(\)/,
    'abrir o chat zera o contador',
  );
});

test('a mencao e contada mesmo com "nao perturbe" ligado', () => {
  /*
   * `nao perturbe` corta som, notificacao e destaque. Se cortasse tambem a
   * contagem, a opcao viraria "nao me avise" — e a mencao deixaria de ser sinal
   * para virar conteudo. O aviso dentro do app e a camada de que mais se pode
   * depender, e ele depende da contagem.
   */
  const iNaoPerturbe = hook.indexOf('if (!naoPerturbe)');
  const iContagem = hook.indexOf('setNaoLidas(');
  assert.ok(iNaoPerturbe !== -1 && iContagem !== -1, 'os dois precisam existir');
  assert.ok(
    iContagem > iNaoPerturbe,
    'a contagem fica DEPOIS do bloco de perturbacao, e fora dele',
  );
  const bloco = hook.slice(iNaoPerturbe, iContagem);
  assert.ok(
    !/setNaoLidas/.test(bloco),
    'a contagem nao pode estar dentro do "se perturbe"',
  );
});

test('o som subiu de 0.16 para 0.5', () => {
  /*
   * 0.16 foi escolhido ouvindo no silencio, que e o erro classico: o som de um
   * player e lembrado no volume em que as pessoas ouvem musica, e nao no
   * silencio. Quem tem a sala tocando tem o volume do video, e o bip sumia
   * embaixo dele.
   *
   * O teste existe para o numero nao voltar sozinho numa "limpeza de ganho".
   */
  const som = readFileSync(
    resolve(process.cwd(), '../web/lib/mentionSound.ts'),
    'utf8',
  );
  assert.match(som, /linearRampToValueAtTime\(0\.5, agora \+ 0\.008\)/, 'o ganho precisa ser 0.5');
  assert.ok(
    !/linearRampToValueAtTime\(0\.16/.test(som),
    'o 0.16 era o valor baixo que o relato apontou',
  );
});

test('a notificacao tem icone proprio e nao o favicon', () => {
  /*
   * Sem `icon`, o Chrome usa o favicon da página — que é o logo do Juntos. Numa
   * notificação de "fulano te mencionou", o logo do site faz a notificação
   * parecer que o próprio site está falando.
   */
  assert.match(hook, /icon: '\/mention-48x48\.png'/, 'a notificação precisa de ícone próprio');
  assert.match(hook, /tag: `mencao-\$\{evento\.messageId\}`/, 'e de tag por mensagem');
});

test('o aviso dentro do app existe, e é a camada confiável', () => {
  /*
   * A notificação do sistema é a camada de que menos se pode depender: o
   * navegador pode tê-la bloqueada, o sistema pode agrupar, e em vários sistemas
   * ela aparece no canto da tela, longe da janela que a pessoa está olhando.
   *
   * O aviso dentro do app é o que garante a informação — *quem me chamou* — que
   * nenhuma das outras camadas carrega sozinha.
   */
  const banner = readFileSync(
    resolve(process.cwd(), '../web/components/chat/MentionBanner.tsx'),
    'utf8',
  );
  assert.match(banner, /te mencionou/, 'o aviso diz quem chamou');
  assert.match(banner, /aria-live="polite"/, 'e é anunciado para leitor de tela');
  assert.match(
    pagina,
    /mencoes\.ultimaMencao && !sidebarOpen/,
    'o aviso só aparece com o painel fechado: com ele aberto a mensagem já está na tela',
  );
});
