import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O vigia do login que não voltou.
 *
 * ## O buraco
 *
 * O OAuth do Drive é a única parte do fluxo em que a nossa página sai e alguém
 * decide se volta. Se o Google morre na tela de escolha de conta, o callback
 * nunca chega, e o app fica parado com o botão de conectar sem dizer nada. Do
 * lado de quem olha, "o botão não funciona" e "o Google recusou" são a mesma
 * coisa — e foi exatamente isso que aconteceu: a tela do Google mostrou
 * `unknownerror_view` e o app não deu nenhuma pista de onde o fluxo parou.
 *
 * ## Por que estes testes são de arquivo próprio
 *
 * A marcação vive em `sessionStorage` e é avaliada dentro de `refresh`, com
 * relógio. Travar isso no texto é o que dá: o erro que este vigia previne foi
 * silencioso por definição, e um teste que só passaria com o browser real não
 * impediria a próxima regressão de sumir sem aviso.
 */
const hook = readFileSync(
  resolve(process.cwd(), '../web/hooks/useDriveAccount.tsx'),
  'utf8',
);

test('o login que parte deixa um carimbo antes de sair da pagina', () => {
  /*
   * A ordem é o que importa, e é o oposto do que parece natural. A página morre
   * em `location.assign`, então marcar depois não marcaria nunca — o `useState`
   * se perde junto com o documento. `marcarEspera()` precisa aparecer antes do
   * `location.assign` na fonte.
   */
  const iMarcao = hook.indexOf('marcarEspera();\n      window.location.assign(');
  const iNavega = hook.indexOf('window.location.assign(driveConnectUrl(returnTo));');
  assert.ok(iMarcao !== -1, 'o carimbo tem que ser escrito antes de navegar para o Google');
  assert.ok(iNavega !== -1, 'o caminho web continua navegando para o /start');
  assert.ok(iMarcao < iNavega, 'marcar depois da navegação não sobrevive: a página já morreu');
});

test('o carimbo sobrevive a navegacao porque vai para o sessionStorage', () => {
  /*
   * `useState` não sobreviveria à navegação, e sem o carimbo não há como dizer
   * que o login partiu. `localStorage` sobreviveria, mas é compartilhado entre
   * abas: um login que começou em outra aba acusaria esta. O vigia precisa ser
   * do login que saiu daqui.
   */
  assert.match(
    hook,
    /marcarEspera[\s\S]*?window\.sessionStorage\.setItem\(CHAVE_ESPERA/,
    'a marcação precisa usar sessionStorage para atravessar a navegação',
  );
  assert.ok(
    !/localStorage\.setItem\(CHAVE_ESPERA/.test(hook),
    'localStorage é compartilhado entre abas e acusaria o login errado',
  );
});

test('o vigia so fala quando a conta continua desconectada', () => {
  /*
   * Sem esta condição, uma conta já conectada que reteve um carimbo velho
   * receberia "o Google não voltou" — o oposto do que aconteceu. O vigia
   * verifica `connected` no mesmo `refresh`, então a ordem entre os dois é o
   * que garante que o estado ganha.
   */
  const iEspere = hook.indexOf('const quando = lerEspera();');
  assert.ok(iEspere !== -1, 'o vigia precisa ser avaliado dentro do refresh');
  const trecho = hook.slice(iEspere, iEspere + 320);
  assert.match(
    trecho,
    /Date\.now\(\) - quando > ESPERA_MS/,
    'o prazo precisa ser conferido antes de acusar',
  );
  assert.match(trecho, /limparEspera\(\)/, 'e o carimbo é limpo ao acusar, para não repetir');
});

test('conectar de novo zera a espera anterior', () => {
  /*
   * Sem isto, um login que falhou há uma hora continuaria acusando depois que a
   * pessoa clica em conectar de novo. O clique é o gesto de quem está tentando
   * de novo, e ele precisa zerar a contagem do erro antigo.
   *
   * O zeramento vem do `setItem` sobrescrever, e não de um `limparEspera`
   * explícito. O que precisa valer é que `marcarEspera` seja chamado sem
   * nenhuma guarda nova dentro do ramo web: o `if (!isDesktop())` é a divisão
   * entre web e desktop e não conta, mas se alguém acrescentar uma condição
   * depois dela — um `if (!busy)`, um `if (status.connected)` — o carimbo velho
   * sobrevive e o vigia acusa na hora, sem nenhum aviso.
   */
  const iConnect = hook.indexOf('const connect = useCallback');
  assert.ok(iConnect !== -1, 'o connect precisa existir');
  const corpo = hook.slice(iConnect, iConnect + 2000);
  const iRamo = corpo.indexOf('if (!isDesktop())');
  const marco = corpo.indexOf('marcarEspera();');
  assert.ok(iRamo !== -1, 'o desvio web/desktop precisa existir');
  assert.ok(marco !== -1, 'conectar precisa remarcar a espera');
  assert.ok(marco > iRamo, 'a marcação do login parte tem de estar no ramo web');
  assert.ok(
    !/if\s*\(/.test(corpo.slice(iRamo + 'if (!isDesktop())'.length, marco)),
    'a remarcação não pode ganhar uma guarda nova, senão o carimbo velho sobrevive',
  );
  assert.ok(
    /if \('error' in resposta\) \{[\s\S]{0,400}?limparEspera\(\)/.test(corpo),
    'quando o servidor recusa de saida nao ha login esperando, e a marca e limpa',
  );
});

test('o retorno do Google encerra a espera mesmo quando ele recusa', () => {
  /*
   * `denied` e `error` chegam com `?drive=`, e nesses casos o Google voltou: a
   * pessoa tem um motivo, e ele e mais especifico que "nao voltou". Sem esta
   * limpeza o vigia acordaria depois e sobrescreveria a recusa com a mensagem
   * errada — o mesmo defeito de mensagem que contraria o estado, so invertido.
   */
  const bloco = hook.slice(hook.indexOf('setMessage(aviso);'), hook.indexOf('const connect'));
  assert.match(
    bloco,
    /limparEspera\(\);/,
    'qualquer retorno do Google encerra a espera do vigia',
  );
});

test('a mensagem diz o que sabemos e nao inventa a causa', () => {
  /*
   * A regra do projeto: diagnostico devolve motivo, nunca chute. Aqui a causa é
   * do Google e acontece antes de qualquer chamada ao nosso servidor, então
   * não é nossa para afirmar. A mensagem declara o fato verificavel — partiu e
   * não voltou — e aponta a checagem. Se alguém escrever "o Google está fora" ou
   * "o token expirou" aqui, este teste não pega, mas ele trava o piso: tem que
   * existir uma mensagem, e ela não pode ser a genérica de "tente de novo".
   */
  const msg = hook.match(/const LOGIN_NAO_VOLTOU =\s*\n?\s*'([^']+)'/);
  assert.ok(msg, 'a mensagem do vigia precisa existir');
  const texto = msg[1];
  assert.match(texto, /não voltou/i, 'a mensagem precisa dizer que o login nao voltou');
  assert.ok(
    !/Tente de novo\.$/.test(texto),
    'a mensagem nao pode ser o "tente de novo" generico que ja existia',
  );
  assert.ok(texto.length > 60, 'a mensagem precisa trazer o caminho, nao so o rotulo');
});

test('falta de storage nao pode derrubar o login', () => {
  /*
   * `sessionStorage` lança em modo privado restrito e em contexto bloqueado. Se
   * a marcação propagar isso, o `connect` quebra justo onde já estava
   * funcionando — trocar uma mensagem ausente por uma conexão impossível.
   */
  assert.match(
    hook,
    /function marcarEspera\(\)[\s\S]*?} catch \{/,
    'marcarEspera precisa envolver o storage em try/catch',
  );
  assert.match(
    hook,
    /function lerEspera\(\)[\s\S]*?} catch \{/,
    'lerEspera tambem, porque roda dentro do refresh',
  );
});
