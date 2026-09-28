const MAX_MESSAGES = 5;
const CHAT_WINDOW_MS = 3000;
/** Bloqueia "aaaaaaaaaaaa" e afins: mais de 10 repetições seguidas do mesmo caractere. */
const FLOOD_PATTERN = /(.)\1{10,}/;

/** Reações e sons com limitações para não virar flood visual/sonoro. */
const MAX_REACTIONS = 20;
const REACTION_WINDOW_MS = 4000;

/**
 * "Digitando...": o cliente já só emite na transição (começou/parou), não a
 * cada tecla, então esse teto é só para um cliente adulterado que ignore
 * isso e tente floodar a sala.
 */
const MAX_TYPING_EVENTS = 15;
const TYPING_WINDOW_MS = 4000;

/** Emissão de token de upload: os arquivos já são grandes, não precisa de muitos por minuto. */
const MAX_UPLOAD_TOKENS = 6;
const UPLOAD_WINDOW_MS = 60_000;

/**
 * Menções: o cooldown que impede uma pessoa de encher o som de outra.
 *
 * ## Por que o limite é por par, e não por remetente
 *
 * A chave é `mencao:<remetente>:<citado>`. Um teto por remetente ("no máximo 5
 * menções por minuto") não resolve o problema: bastariam duas pessoas formando
 * um turno para manter o som de alguém tocando sem parar, e o problema não é o
 * remetente, é a vítima do som. Por par, cada combinação não consegue tocar a
 * mesma pessoa mais de uma vez a cada 20s, e o número de pessoas na sala deixa de
 * amplificar o incômodo.
 *
 * ## Por que cooldown e não janela deslizante
 *
 * A janela deslizante conta eventos num intervalo. Aqui o que importa é o
 * **intervalo entre dois toques**, não a contagem: a pessoa citada precisa de um
 * silêncio de verdade entre um toque e o seguinte para conseguir ler a mensagem
 * e responder. Então é carimbo de tempo do último toque, e só o último vale.
 *
 * ## Por que 20 segundos
 *
 * Tempo suficiente para ler "@Maria você viu essa cena?", responder ou não, e
 * decidir se precisa de novo. Menor que isso vira alarme; maior que isso a
 * menção perde a função, que é a de ser imediata.
 */
const MENTION_COOLDOWN_MS = 20_000;

/** Último toque de som por par remetente→citado. Só o último interessa. */
const ultimoToque = new Map<string, number>();

/**
 * Decide se este par pode tocar o som de menção agora.
 *
 * Devolve `true` quando **pode**. Registrar o toque é parte da função, e não um
 * passo separado do chamador: separar os dois deixa a chance de um caminho
 * chamarem sem o outro, e aí o cooldown vira decorativo.
 */
export function podeTocarMencao(de: string, para: string): boolean {
  const chave = `mencao:${de}:${para}`;
  const agora = Date.now();
  const anterior = ultimoToque.get(chave);
  if (anterior !== undefined && agora - anterior < MENTION_COOLDOWN_MS) {
    return false;
  }
  ultimoToque.set(chave, agora);
  return true;
}

/**
 * Limpa os carimbos de um socket que saiu.
 *
 * Sem isto o `Map` cresce para sempre: cada par que se encontrou deixa uma
 * entrada, e uma sala de watch party tem gente entrando e saindo a noite toda.
 * É o mesmo motivo de `clearRateLimit`.
 */
export function limparMencoes(socketId: string): void {
  const prefixo = `mencao:${socketId}:`;
  for (const chave of [...ultimoToque.keys()]) {
    if (chave.startsWith(prefixo)) ultimoToque.delete(chave);
  }
  // Menções feitas **para** o socket que saiu também somam, e a chave delas
  // começa por outro remetente — daí a segunda varredura, pelo final da chave.
  const sufixo = `:${socketId}`;
  for (const chave of [...ultimoToque.keys()]) {
    if (chave.endsWith(sufixo)) ultimoToque.delete(chave);
  }
}

/** ~500 KB de data URL já cobre uma imagem 640px comprimida em JPEG com folga. */
const MAX_IMAGE_DATA_URL_LENGTH = 500_000;
/** URLs de GIF vêm de um provedor (Tenor/Giphy) e são curtas; nada perto disso é legítimo. */
const MAX_GIF_URL_LENGTH = 500;

const windows = new Map<string, number[]>();

/**
 * Janela deslizante em memória, por chave (ex.: `chat:<socket.id>`). Cada
 * socket vive em uma única instância do processo (o adapter do Redis só
 * cuida do broadcast entre instâncias), então não precisa compartilhar isso
 * entre servidores.
 */
function slidingWindowHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  windows.set(key, timestamps);
  return timestamps.length > max;
}

export function isRateLimited(socketId: string): boolean {
  return slidingWindowHit(`chat:${socketId}`, MAX_MESSAGES, CHAT_WINDOW_MS);
}

export function isReactionRateLimited(socketId: string): boolean {
  return slidingWindowHit(`reaction:${socketId}`, MAX_REACTIONS, REACTION_WINDOW_MS);
}

export function isTypingRateLimited(socketId: string): boolean {
  return slidingWindowHit(`typing:${socketId}`, MAX_TYPING_EVENTS, TYPING_WINDOW_MS);
}

export function isUploadRateLimited(socketId: string): boolean {
  return slidingWindowHit(`upload:${socketId}`, MAX_UPLOAD_TOKENS, UPLOAD_WINDOW_MS);
}

export function clearRateLimit(socketId: string): void {
  windows.delete(`chat:${socketId}`);
  windows.delete(`reaction:${socketId}`);
  windows.delete(`upload:${socketId}`);
  windows.delete(`typing:${socketId}`);
}

/**
 * Filtro de conteúdo intencionalmente simples: corta o texto, recusa
 * flood de caractere repetido e normaliza espaços. Para uma sala aberta ao
 * público em geral, troque por uma lista de termos curada ou um serviço de
 * moderação.
 */
export function sanitizeMessage(raw: string): string | null {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  if (!text) return null;
  if (FLOOD_PATTERN.test(text)) return null;
  return text;
}

/** Legenda opcional de GIF/imagem: mesma limpeza da mensagem, mas pode ficar vazia. */
export function sanitizeCaption(raw: string | undefined): string {
  return sanitizeMessage(raw ?? '') ?? '';
}

/** Aceita só data URLs de imagem, dentro do teto de tamanho combinado com o cliente. */
export function sanitizeImageDataUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('data:image/')) return null;
  if (raw.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  return raw;
}

/** Aceita só links https curtos que é o formato que o Giphy devolve. */
export function sanitizeGifUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^https:\/\//.test(raw)) return null;
  if (raw.length > MAX_GIF_URL_LENGTH) return null;
  return raw;
}
