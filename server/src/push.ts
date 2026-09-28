import type { Express } from 'express';
import webpush from 'web-push';
import { redis } from './redis.js';

/**
 * Aviso de menção com o site **fechado**.
 *
 * ## Onde esta camada se encaixa
 *
 * A menção tem quatro destinos possíveis, e este é o único em que o servidor
 * não entrega por socket:
 *
 *   - aba em foco     -> o cliente toca o som e mostra o aviso dentro do app
 *   - aba em segundo  -> o cliente usa a Notification API, com o socket vivo
 *   - site fechado    -> não há socket nenhum. É este arquivo.
 *   - Electron        -> o processo principal abre a janela e a notificação nativas
 *
 * Só o terceiro caso chega aqui, e ele é decidido por um sinal simples: a pessoa
 * citada **não tem socket vivo**. Se tem, o caminho do socket é mais barato, mais
 * imediato e não depende de nenhum serviço externo.
 *
 * ## Por que isto exige a janela de ausência de 15 minutos
 *
 * O destinatário de um push tem que existir. Quem resolve `@Beni` é
 * `extrairMencoes`, contra `room.users` — e é de lá que a pessoa some quando passa
 * do `PRESENCE_TIMEOUT_MS`. Com a janela de 30 segundos que existia antes, quem
 * fechava a aba e voltava dez minutos depois já não estava na sala, e a menção a
 * essa pessoa não resolvia contra ninguém: sem destaque, sem evento, sem
 * destinatário. Não era o push que falhava; a menção não chegava a existir.
 */

/** Chaves VAPID, geradas com `npx web-push generate-vapid-keys`. */
const PUBLICA = (process.env.VAPID_PUBLIC_KEY ?? '').trim();
const PRIVADA = (process.env.VAPID_PRIVATE_KEY ?? '').trim();

/**
 * Contato do VAPID. A especificação exige `mailto:` ou `https:`, e o serviço de
 * push do navegador rejeita a assinatura sem isso.
 */
const CONTATO = (process.env.VAPID_SUBJECT ?? 'mailto:suporte@juntos.app').trim();

/**
 * Push desligado é uma configuração **válida**, não um erro.
 *
 * O `web-push` lança no primeiro uso quando faltam chaves, e o efeito seria o
 * inverso do que se espera de uma variável ausente: um servidor de sala
 * derrubando mensagens por causa de uma variável de notificação. Aqui tudo vira
 * no-op e a menção continua indo por socket, que é o caminho que já funcionava.
 */
export const pushConfigurado = PUBLICA.length > 0 && PRIVADA.length > 0;

if (pushConfigurado) {
  webpush.setVapidDetails(CONTATO, PUBLICA, PRIVADA);
} else {
  console.warn(
    '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ausentes: aviso com o site fechado desligado. ' +
      'As outras tres camadas (som, aviso no app, Notification API) continuam funcionando.',
  );
}

interface Subscricao {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const chaveDe = (userId: string): string => `push:subs:${userId}`;

async function ler(userId: string): Promise<Subscricao[]> {
  const bruto = await redis.get(chaveDe(userId));
  if (!bruto) return [];
  try {
    const lido = JSON.parse(bruto);
    return Array.isArray(lido) ? (lido as Subscricao[]) : [];
  } catch {
    // Conteúdo corrompido não pode virar exceção dentro do envio de uma menção:
    // a assinatura é o melhor effort, e apagar a lista é a resposta honesta.
    await redis.del(chaveDe(userId));
    return [];
  }
}

/** A chave pública que o navegador precisa para se inscrever. */
export function chavePublicaVapid(): string | null {
  return pushConfigurado ? PUBLICA : null;
}

/**
 * Guarda a inscrição, e troca a que tiver o mesmo endpoint.
 *
 * Uma pessoa pode ter o site aberto em vários aparelhos ao mesmo tempo, e cada
 * um gera um endpoint próprio — daí a lista, e não um valor só.
 *
 * A troca em vez do acréscimo é o que impede a lista de crescer sem parar: o
 * `subscribe()` do navegador devolve o mesmo endpoint quando já está inscrito, e
 * acrescentá-lo de novo criaria uma cópia a cada abertura de aba. O efeito seria
 * a mesma menção chegar três vezes no mesmo aparelho.
 */
export async function registrarInscricao(userId: string, sub: Subscricao): Promise<number> {
  if (!pushConfigurado) return 0;
  const atual = await ler(userId);
  const semEste = atual.filter((s) => s.endpoint !== sub.endpoint);
  const nova = [...semEste, sub];
  await redis.set(chaveDe(userId), JSON.stringify(nova));
  return nova.length;
}

/**
 * Remove um endpoint. Chamado quando o navegador cancela a inscrição e quando o
 * serviço responde que o endereço morreu.
 */
export async function removerInscricao(userId: string, endpoint: string): Promise<boolean> {
  const atual = await ler(userId);
  const restante = atual.filter((s) => s.endpoint !== endpoint);
  if (restante.length === atual.length) return false;
  if (restante.length === 0) await redis.del(chaveDe(userId));
  else await redis.set(chaveDe(userId), JSON.stringify(restante));
  return true;
}

export interface AvisoDeMencao {
  messageId: string;
  fromName: string;
  texto: string;
  preview: string;
  roomId: string;
}

/**
 * Envia o aviso para todos os aparelhos inscritos de uma pessoa.
 *
 * ## Por que um 404 ou 410 apaga a inscrição
 *
 * O serviço de push responde 404/410 quando o endpoint não existe mais — o
 * navegador limpou os dados do site, o perfil foi removido, o certificado venciu.
 * A resposta não é um erro passageiro: aquele endereço está morto para sempre.
 *
 * Deixar o endpoint na lista significa pagar uma chamada de rede que falha em
 * **toda** menção, para sempre, sem que nada improve. Por isso o 404/410 remove.
 *
 * ## Por que nada aqui pode derrubar a menção
 *
 * A mensagem, o destaque e o evento de socket já saíram antes daqui. Um push que
 * falhou é a camada mais externa de quatro: ela some e a pessoa continua vendo
 * `@fulano` no texto, que é a parte que sempre funcionou. Por isso tudo é
 * engolido, e só o motivo vai para o log.
 */
export async function enviarPara(userId: string, aviso: AvisoDeMencao): Promise<number> {
  if (!pushConfigurado) return 0;

  const inscricoes = await ler(userId);
  if (inscricoes.length === 0) return 0;

  const carga = JSON.stringify({
    title: `${aviso.fromName} te mencionou`,
    body: aviso.preview || `@${aviso.texto}`,
    tag: `mencao-${aviso.messageId}`,
    icon: '/mention-48x48.png',
    badge: '/favicon.ico',
    roomId: aviso.roomId,
  });

  let entregues = 0;

  for (const sub of inscricoes) {
    try {
      await webpush.sendNotification(sub, carga);
      entregues += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await removerInscricao(userId, sub.endpoint);
        continue;
      }
      /*
       * 401 e 403 são o outro grupo que não adianta tentar de novo: a assinatura
       * VAPID está recusada. Isso é configuração quebrada do servidor, não do
       * aparelho, e vale uma linha no log — silenciar deixaria o aviso de
       * mentions com o site fechado simplesmente nunca aparecer, sem sinal.
       */
      if (status === 401 || status === 403) {
        console.error('[push] assinatura recusada (401/403): confira VAPID_SUBJECT e as chaves');
        continue;
      }
      // 429 e 5xx são passageiros: o endereço continua válido e a próxima menção tenta.
      console.warn(`[push] envio falhou (${status ?? 'sem status'}): ${(err as Error).message}`);
    }
  }

  return entregues;
}

/**
 * Rotas de inscrição.
 *
 * `GET /api/push/public-key` é lida pelo navegador na hora de se inscrever, e é
 * por isso que a chave não é embutida no build: o mesmo bundle de produção
 * passa a falar com o servidor de destino sem novo build.
 */
export function registrarRotasPush(app: Express): void {
  app.get('/api/push/public-key', (_req, res) => {
    if (!pushConfigurado) return res.status(503).json({ error: 'push_not_configured' });
    res.json({ publicKey: PUBLICA });
  });

  app.post('/api/push/subscribe', async (req, res) => {
    if (!pushConfigurado) return res.status(503).json({ error: 'push_not_configured' });

    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const sub = req.body?.subscription as Partial<Subscricao> | undefined;

    if (!userId) return res.status(400).json({ error: 'userId_required' });
    if (typeof sub?.endpoint !== 'string' || !sub.endpoint) {
      return res.status(400).json({ error: 'endpoint_required' });
    }
    if (typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') {
      return res.status(400).json({ error: 'keys_required' });
    }

    try {
      const total = await registrarInscricao(userId, {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
      res.json({ ok: true, total });
    } catch (err) {
      console.error('[push] falha ao guardar a inscrição', err);
      res.status(500).json({ error: 'subscribe_failed' });
    }
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!userId || !endpoint) return res.status(400).json({ error: 'userId_and_endpoint_required' });
    try {
      await removerInscricao(userId, endpoint);
      res.json({ ok: true });
    } catch (err) {
      console.error('[push] falha ao remover a inscrição', err);
      res.status(500).json({ error: 'unsubscribe_failed' });
    }
  });
}
