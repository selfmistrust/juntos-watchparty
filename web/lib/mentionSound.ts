/**
 * O som curto de atenção da menção.
 *
 * ## Por que sintetizado, e não um arquivo
 *
 * Não há arquivo de áudio no projeto, e adicionar um significaria decidir
 * licença, tamanho e empacotamento — em cima de uma função que é um bip. Duas
 * senoides curtas pelo `AudioContext` fazem o mesmo trabalho em zero bytes, em
 * zero requisições e sem depender de formato que cada navegador trate
 * diferente. Um `.mp3` seria mais bytes para o mesmo som, e o motivo seria ter
 * um arquivo.
 *
 * ## O problema do `AudioContext`, e o que este código faz com ele
 *
 * Nenhum navegador deixa tocar áudio antes de um gesto da pessoa. Criar o
 * contexto já no load não resolve: ele nasce `suspended` e só destrava no
 * primeiro clique ou tecla.
 *
 * A saída obvável — listener global de clique instalado no load, só para
 * destravar — é o que o `ReactionDock` registra como o motivo de o `lib/sfx`
 * antigo ter sido removido: um listener que nunca é desinstalado, em todo o
 * app, por causa de um som. Quem apagar o som apaga também o listener; quem
 * mantiver o som herda um listener global sem perceber.
 *
 * Aqui o destravamento é escopado ao campo de mensagem: o `onFocus` do
 * textarea é um gesto da pessoa, e é exatamente o gesto que precede alguém
 * escrever `@Maria`. Ninguém que não vai escrever no chat paga por isso, e não
 * há nada global para vazar.
 *
 * ## Por que o som não pode ser o do remetente
 *
 * O som toca **na máquina de quem foi citado**, a partir do evento privado que
 * o servidor mandou só para ela. Não há `sound:trigger` nem reenvio para a sala —
 * o `ReactionDock` registra que essa bridging existiu e foi removida justamente
 * por ecoar som para os outros.
 */

let contexto: AudioContext | null = null;
let destravado = false;

type ContextoComSafari = AudioContext & { webkitAudioContext?: typeof AudioContext };

/**
 * Cria (uma vez) o contexto de áudio, ou devolve o que já existe.
 *
 * Devolve `null` quando o navegador não tem Web Audio — que é raro, mas
 * acontece em contexto não seguro antigo. A ausência de som é aceitável; uma
 * exceção no caminho da notificação não é, porque a notificação é a parte que
 * a pessoa mais precisa ver.
 */
function contextoDeAudio(): AudioContext | null {
  if (contexto) return contexto;
  if (typeof window === 'undefined') return null;
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as ContextoComSafari).webkitAudioContext;
    if (!Ctor) return null;
    contexto = new Ctor();
    return contexto;
  } catch {
    return null;
  }
}

/**
 * Destrava o áudio. Chamar de um gesto da pessoa — aqui, o foco no campo de
 * mensagem.
 *
 * `resume()` é idempotente e não lança se o contexto já estiver rodando, então
 * não é preciso guardar se já destravou: a checagem é só para não fazer a
 * chamada à toa a cada foco.
 */
export function destravarSomDeMencao(): void {
  if (destravado) return;
  const ctx = contextoDeAudio();
  if (!ctx) return;
  if (ctx.state === 'running') {
    destravado = true;
    return;
  }
  // A promessa é intencionalmente ignorada: `resume()` pode rejeitar sem
  // gesto válido, e isso não é motivo para derrubar quem chamou.
  void ctx.resume().catch(() => undefined);
  destravado = true;
}

/**
 * Toca o som de menção.
 *
 * Dois tons agudos e curtos, o suficiente para ser reconhecidos como "alguém te
 * chamou" sem cobrir o áudio do vídeo — que é justamente o que está tocando
 * enquanto a sala assiste junto, e é por isso que o ganho é baixo e a
 * duração é curta.
 */
export function tocarSomDeMencao(): void {
  const ctx = contextoDeAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }

  const agora = ctx.currentTime;
  const ganho = ctx.createGain();
  ganho.gain.setValueAtTime(0, agora);
  ganho.connect(ctx.destination);

  /*
   * Envelope curto, com ataque de poucos milissegundos. Um ataque de zero
   * estoura; um sem decaimento deixa o tom ligado depois de passar o bip.
   */
  ganho.gain.linearRampToValueAtTime(0.16, agora + 0.01);
  ganho.gain.exponentialRampToValueAtTime(0.0001, agora + 0.22);

  for (const [indice, frequencia] of [880, 1174].entries()) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequencia, agora + indice * 0.09);
    osc.connect(ganho);
    osc.start(agora + indice * 0.09);
    osc.stop(agora + 0.24);
  }

  /*
   * O nó de ganho é descartado depois de tocar. Sem isto, cada menção deixaria
   * osciladores parados presos ao grafo de áudio — e uma menção por vez já é o
   * cenário raro; o flood é justamente o que o cooldown do servidor corta.
   */
  window.setTimeout(() => {
    try {
      ganho.disconnect();
    } catch {
      // Já desconectado.
    }
  }, 400);
}
