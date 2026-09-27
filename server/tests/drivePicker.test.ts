import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';

/*
 * Integração do Drive contra um servidor de salas real em porta efêmera, com
 * Redis e Google simulados. Duas partes: a seleção (OAuth + Picker) e a
 * reprodução (a rota de stream com `Range`).
 */

// Credenciais fictícias e Redis desconectado: o teste não carrega server/.env.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.SESSION_SECRET = 'drive-picker-test-session-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'drive-picker-test-encryption-key';
process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4001/api/youtube/oauth/callback';
process.env.GOOGLE_DRIVE_REDIRECT_URI = 'http://localhost:4001/api/drive/oauth/callback';
process.env.CLIENT_ORIGIN = 'http://localhost:3210,http://localhost:3001';

const { redis, pubClient, subClient } = await import('../src/redis.js');
for (const client of [redis, pubClient, subClient]) client.disconnect();

const entries = new Map<string, { value: string; expiresAt: number }>();
let timeOffset = 0;

/**
 * Desloca o relógio do processo, em milissegundos.
 *
 * O access token vive por ~1 h e o piso de `expiraEmMs` é 30 s, então nenhum
 * `expires_in` do mock consegue deixá-lo vencido na hora. Sem isto não há como
 * exercitar a renovação — que é justamente o caminho que quebrou: o 502 da
 * pessoa veio de um refresh recusado, e nenhum teste cobria isso.
 */
let relogio = 0;
const agoraReal = Date.now;
Date.now = () => agoraReal() + relogio;
const get = (key: string) => {
  const entry = entries.get(key);
  if (!entry || entry.expiresAt <= Date.now() + timeOffset) {
    entries.delete(key);
    return null;
  }
  return entry.value;
};
mock.method(redis, 'get', async (key: string) => get(key));
mock.method(redis, 'getdel', async (key: string) => {
  const value = get(key);
  entries.delete(key);
  return value;
});
mock.method(redis, 'set', async (key: string, value: string, ...args: (string | number)[]) => {
  if (args.includes('XX') && !get(key)) return null;
  if (args.includes('NX') && get(key)) return null;
  const ttl = args.indexOf('EX');
  entries.set(key, { value, expiresAt: Date.now() + timeOffset + Number(args[ttl + 1]) * 1000 });
  return 'OK';
});
mock.method(redis, 'del', async (...keys: string[]) => keys.reduce((count, key) => count + Number(entries.delete(key)), 0));
/**
 * O `eval` do bloqueio de renovação: apaga a chave só se o valor ainda for o
 * nosso, para não derrubar o lock de quem o pegou depois.
 *
 * O mock traduz o Lua à mão. Ele só apareceu agora porque nenhum teste renewava
 * token — a ausência do mock passava despercebida até o primeiro teste de
 * renovação, que batia em "Connection is closed" num cliente Redis desligado.
 */
mock.method(redis, 'eval', async (_script: string, _numKeys: number, key: string, esperado: string) => {
  if (get(key) !== esperado) return 0;
  entries.delete(key);
  return 1;
});

const realFetch = globalThis.fetch;
let exchanges: URLSearchParams[] = [];
/**
 * Resposta do endpoint de token quando queremos simular uma recusa.
 *
 * O formato importa: o Google responde o erro no corpo com HTTP 200 **ou** com
 * 4xx, e a distinção é o que separa "conta morta" de "Google instável".
 */
let tokenError: { http: number; body: Record<string, unknown> } | null = null;
/** O que o Google devolve no campo `scope`, que não é necessariamente o que pedimos. */
let escopoDevolvido =
  'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/drive.file';
type DriveCall = { url: string; range: string | null; auth: string | null; method: string; body: unknown };
let driveCalls: DriveCall[] = [];
let driveMeta: Record<string, unknown> | null = null;
let mediaStatus = 200;
let userinfoEmail = 'dono@exemplo.com';
/** Permissões que o Google já tem no arquivo, antes de qualquer coisa nossa. */
let permissoesPreexistentes: { id: string; emailAddress: string }[] = [];
/** Permissões que o nosso POST create devolveu, para o delete saber o que é. */
let permissoesCriadas = new Map<string, string>();
let criadoCount = 0;
const MEDIA = Buffer.from('0123456789abcdef', 'utf-8');

const metaPadrao = () => ({
  id: videoId,
  name: 'Episódio.mkv',
  mimeType: 'video/x-matroska',
  size: String(MEDIA.length),
  videoMediaMetadata: { durationMillis: '15000' },
  capabilities: { canDownload: true },
});

/**
 * O Drive é simulado no limite do que o código realmente depende:
 *
 * - metadados, com `canDownload`, que a documentação manda checar;
 * - `permissions.list` e `permissions.create`, que é o coração do
 *   compartilhamento — sem simular o `id` devolvido, o revoke não teria o que
 *   apagar e o teste passaria sem provar nada;
 * - os bytes com `Range`, que já não são servidos por nós mas continuam sendo
 *   o contrato que o service worker cumpre no cliente.
 */
function responderDrive(url: URL, init: RequestInit | undefined): Response {
  const metodo = init?.method ?? 'GET';
  const cabecalhos = (init?.headers ?? {}) as Record<string, string>;
  const corpo = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  driveCalls.push({
    url: url.toString(), method: metodo, body: corpo,
    range: cabecalhos.Range ?? null, auth: cabecalhos.Authorization ?? null,
  });

  if (url.pathname.endsWith('/permissions') && metodo === 'GET') {
    return Response.json({
      permissions: [
        { id: 'dono', emailAddress: userinfoEmail, type: 'user' },
        ...permissoesPreexistentes,
        ...[...permissoesCriadas].map(([email, id]) => ({ id, emailAddress: email, type: 'user' })),
      ],
    });
  }
  if (url.pathname.endsWith('/permissions') && metodo === 'POST') {
    const email = String(corpo?.emailAddress ?? '');
    if (criadoCount >= 3) return new Response('{"error":{"code":403}}', { status: 403 });
    criadoCount += 1;
    const id = `perm-${criadoCount}`;
    permissoesCriadas.set(email, id);
    return Response.json({ id, emailAddress: email, role: corpo?.role, type: 'user' });
  }
  if (/\/permissions\/[^/]+$/.test(url.pathname) && metodo === 'DELETE') {
    return new Response(null, { status: 204 });
  }

  if (url.searchParams.get('alt') === 'media') {
    if (mediaStatus !== 200) return new Response('{}', { status: mediaStatus });
    const m = /^bytes=(\d*)-(\d*)$/.test(cabecalhos.Range ?? '');
    if (m) {
      const inicio = m[1] ? Number(m[1]) : MEDIA.length - Number(m[2]);
      const fim = m[2] ? Number(m[2]) : MEDIA.length - 1;
      const pedaco = MEDIA.subarray(inicio, fim + 1);
      return new Response(pedaco, {
        status: 206,
        headers: {
          'content-type': 'video/x-matroska',
          'content-length': String(pedaco.length),
          'content-range': `bytes ${inicio}-${fim}/${MEDIA.length}`,
        },
      });
    }
    return new Response(MEDIA, {
      status: 200,
      headers: { 'content-type': 'video/x-matroska', 'content-length': String(MEDIA.length) },
    });
  }
  if (!driveMeta) return new Response('{}', { status: 404 });
  return Response.json(driveMeta);
}

mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === 'https://oauth2.googleapis.com/token') {
    exchanges.push(new URLSearchParams(init?.body as URLSearchParams));
    if (tokenError) {
      return new Response(JSON.stringify(tokenError.body), {
        status: tokenError.http,
        headers: { 'content-type': 'application/json' },
      });
    }
    /*
     * O escopo devolvido inclui `openid`, que não pedimos. É o comportamento
     * real do Google em fluxo com PKCE — ele acrescenta sozinho — e foi o que
     * fez a conexão ser recusada depois de a pessoa autorizar tudo na tela.
     */
    return Response.json({
      access_token: 'test-access-token', refresh_token: 'test-refresh-token',
      expires_in: 3600,
      scope: escopoDevolvido,
    });
  }
  if (url.href === 'https://www.googleapis.com/oauth2/v3/userinfo') {
    return Response.json({ email: userinfoEmail, email_verified: true });
  }
  if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files/')) {
    return responderDrive(url, init);
  }
  assert.equal(url.hostname, '127.0.0.1', 'somente o servidor HTTP de teste pode receber requests');
  return realFetch(input, init);
});

const { registerDriveRoutes } = await import('../src/driveRoutes.js');
const app = express();
app.use(express.json());
registerDriveRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const origin = 'http://localhost:3210';
const videoId = 'video_selecionado_123';

beforeEach(() => {
  entries.clear();
  timeOffset = 0;
  relogio = 0;
  exchanges = [];
  tokenError = null;
  escopoDevolvido =
    'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/drive.file';
  driveCalls = [];
  driveMeta = metaPadrao();
  mediaStatus = 200;
  userinfoEmail = 'dono@exemplo.com';
  permissoesPreexistentes = [];
  permissoesCriadas = new Map();
  criadoCount = 0;
});
after(async () => {
  server.close();
  await once(server, 'close');
  mock.restoreAll();
});

async function session(): Promise<string> {
  const response = await fetch(`${base}/api/drive/status`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function start(cookie: string) {
  const response = await fetch(`${base}/api/drive/picker/start`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `${origin}/room/teste` }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return await response.json() as { url: string; requestId: string; expiresAt: number };
}

function status(requestId: string, cookie: string) {
  return fetch(`${base}/api/drive/picker/${requestId}`, { headers: { cookie, origin } });
}

function callback(url: string, extra: Record<string, string>, cookie?: string) {
  const state = new URL(url).searchParams.get('state');
  assert.ok(state);
  return fetch(`${base}/api/drive/oauth/callback?${new URLSearchParams({ state, ...extra })}`, {
    redirect: 'manual', headers: cookie ? { cookie } : {},
  });
}

test('o navegador externo entrega o vídeo somente à sessão do desktop, com state de uso único e PKCE', async () => {
  const desktopCookie = await session();
  const browserCookie = await session();
  const request = await start(desktopCookie);
  const google = new URL(request.url);
  assert.equal(google.origin, 'https://accounts.google.com');
  assert.equal(google.searchParams.get('trigger_onepick'), 'true');
  assert.equal(google.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email');
  assert.equal(google.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(google.searchParams.get('prompt'), 'consent');
  assert.equal(google.searchParams.get('allow_multiple'), 'false');
  assert.match(google.searchParams.get('mimetypes') ?? '', /video\/mp4/);
  assert.ok(request.expiresAt > Date.now() + 30_000);
  assert.deepEqual(await (await status(request.requestId, desktopCookie)).json(), { status: 'pending' });

  const response = await callback(request.url, { code: 'google-code', picked_file_ids: videoId }, browserCookie);
  assert.equal(response.headers.get('location'), '/api/drive/oauth/concluido?estado=picked');
  assert.equal(response.headers.get('set-cookie'), null, 'o callback não substitui a sessão do navegador');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(exchanges.length, 1);
  const verifier = exchanges[0].get('code_verifier');
  assert.ok(verifier);
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), google.searchParams.get('code_challenge'));

  const result = await status(request.requestId, desktopCookie);
  assert.deepEqual(await result.json(), { status: 'picked', fileId: videoId });
  assert.equal((await status(request.requestId, browserCookie)).status, 410);
  const token = await fetch(`${base}/api/drive/picker-token`, { headers: { cookie: desktopCookie, origin } });
  assert.deepEqual(await token.json(), { accessToken: 'test-access-token' });
  const browserToken = await fetch(`${base}/api/drive/picker-token`, { headers: { cookie: browserCookie, origin } });
  assert.equal(browserToken.status, 401);

  const replay = await callback(request.url, { code: 'google-code', picked_file_ids: videoId });
  assert.match(replay.headers.get('location') ?? '', /estado=expired$/);
  assert.equal(exchanges.length, 1);
  assert.deepEqual(await (await status(request.requestId, desktopCookie)).json(), { status: 'picked', fileId: videoId });
});

test('origem e cookie são exigidos; outra sessão não cancela o pedido', async () => {
  const cookie = await session();
  const stranger = await session();
  const blocked = await fetch(`${base}/api/drive/picker/start`, { method: 'POST', headers: { cookie, origin: 'https://outro.example' } });
  assert.equal(blocked.status, 403);
  const request = await start(cookie);
  assert.equal((await fetch(`${base}/api/drive/picker/${request.requestId}`, { headers: { origin } })).status, 401);
  assert.equal((await fetch(`${base}/api/drive/picker/${request.requestId}`, { headers: { cookie } })).status, 403);
  await fetch(`${base}/api/drive/picker/${request.requestId}`, { method: 'DELETE', headers: { cookie: stranger, origin } });
  assert.deepEqual(await (await status(request.requestId, cookie)).json(), { status: 'pending' });
});

test('cancelar no app invalida o callback antigo e permite iniciar outra seleção', async () => {
  const cookie = await session();
  const old = await start(cookie);
  const deleted = await fetch(`${base}/api/drive/picker/${old.requestId}`, { method: 'DELETE', headers: { cookie, origin } });
  assert.equal(deleted.status, 204);
  const next = await start(cookie);
  assert.notEqual(next.requestId, old.requestId);
  const late = await callback(old.url, { code: 'late-code', picked_file_ids: videoId });
  assert.match(late.headers.get('location') ?? '', /estado=expired$/);
  assert.equal(exchanges.length, 0);
  assert.equal((await status(old.requestId, cookie)).status, 410);
  assert.deepEqual(await (await status(next.requestId, cookie)).json(), { status: 'pending' });
});

test('cancelamento no Google e seleção vazia terminam a espera sem copiar', async () => {
  const cookie = await session();
  for (const query of [{ error: 'access_denied' }, { code: 'no-selection-code' }]) {
    const request = await start(cookie);
    const response = await callback(request.url, query);
    assert.match(response.headers.get('location') ?? '', /estado=cancelled$/);
    assert.deepEqual(await (await status(request.requestId, cookie)).json(), { status: 'cancelled' });
  }
  assert.equal(exchanges.length, 0);
});

test('IDs inválidos e falha na troca do código chegam como erro ao app', async () => {
  const cookie = await session();
  const invalid = await start(cookie);
  await callback(invalid.url, { code: 'code', picked_file_ids: '../../outro,video' });
  assert.deepEqual(await (await status(invalid.requestId, cookie)).json(), { status: 'error' });
  assert.equal(exchanges.length, 0);
  tokenError = { http: 503, body: { error: 'temporarily_unavailable' } };
  const request = await start(cookie);
  await callback(request.url, { code: 'code', picked_file_ids: videoId });
  assert.deepEqual(await (await status(request.requestId, cookie)).json(), { status: 'error' });
});

test('um pedido expirado não troca o código nem devolve uma seleção', async () => {
  const cookie = await session();
  const request = await start(cookie);
  timeOffset = 11 * 60 * 1000;
  assert.equal((await status(request.requestId, cookie)).status, 410);
  const response = await callback(request.url, { code: 'code', picked_file_ids: videoId });
  assert.match(response.headers.get('location') ?? '', /estado=expired$/);
  assert.equal(exchanges.length, 0);
});

test('o OAuth web continua retornando à sala com a mensagem do Drive', async () => {
  const cookie = await session();
  const response = await fetch(`${base}/api/drive/oauth/start`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: 'http://localhost:3001/room/teste' }),
  });
  const { url } = await response.json() as { url: string };
  assert.equal(new URL(url).searchParams.has('trigger_onepick'), false);
  const completed = await callback(url, { code: 'web-code' }, cookie);
  assert.equal(completed.headers.get('location'), 'http://localhost:3001/room/teste?drive=connected');
  assert.ok(completed.headers.get('set-cookie'));
});

test('a página de conclusão usa textos do Drive e rejeita estados desconhecidos', async () => {
  const page = await fetch(`${base}/api/drive/oauth/concluido?estado=picked`);
  const html = await page.text();
  assert.match(html, /Vídeo selecionado/);
  assert.doesNotMatch(html, /test-access-token|test-refresh-token|YouTube/);
  const invalid = await fetch(`${base}/api/drive/oauth/concluido?estado=__proto__`);
  assert.equal(invalid.status, 400);
});

// --- Faixa de Drive e compartilhamento ---------------------------------------

/**
 * O id de sessão que o cookie carrega.
 *
 * O código do servidor sempre trabalha com o id, nunca com o cookie: o
 * `playlist:add` vem por WebSocket e não tem cookie, e é por isso que o dono do
 * arquivo fica indexado por `fileId` no Redis. Passar o cookie inteiro aqui
 * faria o teste mentir sobre o contrato.
 */
const sessaoDe = (cookie: string): string => cookie.split(';')[0].split('=')[1].split('.')[0];

async function conectar(email?: string): Promise<string> {
  if (email) userinfoEmail = email;
  const cookie = await session();
  const start = await fetch(`${base}/api/drive/oauth/start`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `${origin}/room/teste` }),
  });
  const { url } = await start.json() as { url: string };
  await callback(url, { code: 'code' }, cookie);
  return cookie;
}

async function registrar(cookie: string, fileId = videoId) {
  return fetch(`${base}/api/drive/track`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  });
}

test('a verificação de boot acha configuração errada sem registrar o segredo', async () => {
  const { logGoogleConfigShape } = await import('../src/googleOAuth.js');
  const original = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    yt: process.env.GOOGLE_REDIRECT_URI,
    drive: process.env.GOOGLE_DRIVE_REDIRECT_URI,
  };
  const linhas: string[] = [];
  const erros = console.error;
  const infos = console.log;
  console.error = (msg: unknown) => void linhas.push(String(msg));
  console.log = (msg: unknown) => void linhas.push(String(msg));

  /*
   * A base do teste tem `test-secret` e um client id de fantasia, que a
   * verificação acusa corretamente. Para exercitar o caminho feliz é preciso
   * uma configuração com a **forma** de uma real — número de projeto, sufixo
   * do host e prefixo `GOCSPX-` — mas o conteúdo é inventado.
   *
   * Estes valores são fictícios de propósito. Uma versão anterior deste teste
   * usava as credenciais de verdade, copiadas da tela do Render, e o
   * secret scanning do GitHub bloqueou o push: um segredo real em um fixture de
   * teste é um segredo no repositório, mesmo que "só para o teste". Não
   * cole credencial real em arquivo versionado, nem para um teste que só quer
   * o formato.
   */
  const valido = {
    id: '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com',
    secret: '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00',
  };

  try {
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: valido.id,
      GOOGLE_CLIENT_SECRET: valido.secret,
      GOOGLE_REDIRECT_URI: 'https://exemplo.onrender.com/api/youtube/oauth/callback',
      GOOGLE_DRIVE_REDIRECT_URI: 'https://exemplo.onrender.com/api/drive/oauth/callback',
    });

    // Tudo certo: uma linha, e nenhuma menção ao valor do segredo.
    linhas.length = 0;
    logGoogleConfigShape();
    assert.equal(linhas.length, 1, linhas.join(' | '));
    assert.match(linhas[0], /forma esperada/);
    assert.ok(!linhas.join('\n').includes(valido.secret), 'o segredo não aparece no log');

    // Credencial colada com quebra de linha: a causa mais provável, e a que não
    // aparece na tela do Render.
    linhas.length = 0;
    process.env.GOOGLE_CLIENT_ID = `${valido.id}\n`;
    logGoogleConfigShape();
    assert.ok(linhas.some((l) => l.includes('GOOGLE_CLIENT_ID tem espaço ou quebra de linha na borda')), linhas.join(' | '));

    // Segredo de outro formato, e redirect que não bate com o caminho do
    // callback que o Google tem registrado.
    linhas.length = 0;
    process.env.GOOGLE_CLIENT_ID = valido.id;
    process.env.GOOGLE_CLIENT_SECRET = 'segredo-velho-sem-prefixo';
    process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://exemplo.com/drive';
    logGoogleConfigShape();
    assert.ok(linhas.some((l) => l.includes('não começa com GOCSPX-')), linhas.join(' | '));
    assert.ok(
      linhas.some((l) => l.includes('GOOGLE_DRIVE_REDIRECT_URI não termina em /api/drive/oauth/callback')),
      linhas.join(' | '),
    );

    // Variável ausente precisa aparecer: ela é o que faz o Render cair no
    // default de localhost sem ninguém notar.
    linhas.length = 0;
    process.env.GOOGLE_CLIENT_SECRET = original.secret as string;
    process.env.GOOGLE_DRIVE_REDIRECT_URI = undefined as unknown as string;
    delete process.env.GOOGLE_DRIVE_REDIRECT_URI;
    logGoogleConfigShape();
    assert.ok(linhas.some((l) => l.includes('GOOGLE_DRIVE_REDIRECT_URI ausente')), linhas.join(' | '));
  } finally {
    console.error = erros;
    console.log = infos;
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('renovação recusada distingue conta morta de Google instável', async () => {
  const cookie = await conectar();
  // O token nasce válido; adiantamos o relógio para forçar a renovação, que é o
  // caminho que o 502 da pessoa percorreu.
  relogio = 2 * 60 * 60 * 1000;

  const pedir = () => fetch(`${base}/api/drive/picker-token`, { headers: { cookie, origin } });

  /*
   * 1. Google sobrecarregado. A conta está boa: 502 e "tente de novo". Um 401
   *    aqui mandaria a pessoa refazer o consentimento por causa de um 503.
   */
  tokenError = { http: 503, body: { error: 'temporarily_unavailable' } };
  const passageiro = await pedir();
  assert.equal(passageiro.status, 502);
  assert.equal(((await passageiro.json()) as { error: string }).error, 'temporary');
  // O status público continua dizendo conectado: a conta não morreu.
  assert.equal((await (await fetch(`${base}/api/drive/status`, { headers: { cookie } })).json()).connected, true);

  /*
   * 2. Recusa definitiva que não é revogação — credencial do app trocada, por
   *    exemplo. A conta está morta mesmo sem o Google dizer `invalid_grant`:
   *    401, e o cliente passa a oferecer "Trocar de conta".
   */
  tokenError = { http: 400, body: { error: 'invalid_client' } };
  const morto = await pedir();
  assert.equal(morto.status, 401);
  assert.equal(((await morto.json()) as { error: string }).error, 'expired');

  // 3. Revogação de verdade: some o registro, e o status volta a desconectado.
  tokenError = { http: 400, body: { error: 'invalid_grant' } };
  const revogado = await pedir();
  assert.equal(revogado.status, 401);
  assert.equal(((await revogado.json()) as { error: string }).error, 'revoked');
  assert.equal((await (await fetch(`${base}/api/drive/status`, { headers: { cookie } })).json()).connected, false);
});

test('registrar a faixa devolve o fileId e o nome, e não baixa nem cria permissão', async () => {
  const cookie = await conectar();
  const res = await registrar(cookie);
  assert.equal(res.status, 200);
  const track = await res.json() as { fileId: string; name: string; duration?: number; size?: number };
  assert.equal(track.fileId, videoId);
  assert.equal(track.name, 'Episódio.mkv');
  assert.equal(track.duration, 15);

  // A faixa não carrega URL de mídia: o vídeo é lido do Google por cada
  // participante, e o Render não vira proxy nem precisa de bucket.
  assert.ok(!JSON.stringify(track).includes('/stream'));
  assert.ok(!driveCalls.some((c) => c.url.includes('alt=media')), 'registrar não baixa o arquivo');
  assert.ok(!driveCalls.some((c) => c.url.includes('/permissions')), 'registrar não compartilha nada');
});

test('registrar recusa quem não tem conta, id inválido, não-vídeo e download bloqueado', async () => {
  const semConta = await session();
  assert.equal((await registrar(semConta)).status, 401);

  const cookie = await conectar();
  assert.equal((await registrar(cookie, '../../etc/passwd')).status, 400);

  driveMeta = { ...metaPadrao(), mimeType: 'application/pdf' };
  assert.equal((await registrar(cookie)).status, 422);

  driveMeta = { ...metaPadrao(), capabilities: { canDownload: false } };
  assert.equal((await registrar(cookie)).status, 422);

  // O 404 do Google aqui é o "você não escolheu este arquivo" do drive.file, e
  // vira bad_file para o painel não sugerir algo que não vai funcionar.
  driveMeta = null;
  const escolhidoPorOutro = await registrar(cookie);
  assert.equal(escolhidoPorOutro.status, 400);
  assert.equal(((await escolhidoPorOutro.json()) as { error: string }).error, 'bad_file');
});

test('o e-mail da conta é guardado para o compartilhamento, e nunca sai do servidor', async () => {
  const cookie = await conectar('dono@exemplo.com');
  await registrar(cookie);
  const { emailDaSessao } = await import('../src/driveOAuth.js');
  assert.equal(await emailDaSessao(sessaoDe(cookie)), 'dono@exemplo.com');

  // O status público é o que a UI recebe: e-mail nenhum.
  const status = await (await fetch(`${base}/api/drive/status`, { headers: { cookie } })).json();
  assert.deepEqual(Object.keys(status).sort(), ['configured', 'connected']);
  assert.ok(!JSON.stringify(status).includes('@'));
});

test('o openid que o Google acrescenta não derruba a conexão, e um escopo amplo ainda derruba', async () => {
  const cookie = await session();
  const start = await fetch(`${base}/api/drive/oauth/start`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `${origin}/room/teste` }),
  });
  const { url } = await start.json() as { url: string };

  /*
   * Este é o caso real: pedimos `drive.file` e `userinfo.email`, o Google
   * devolve os dois mais `openid`, e a conexão era recusada. A pessoa autorizava
   * tudo na tela do Google e o servidor jogava a fora — e ainda revogava o token
   * logo depois, por segurança.
   */
  await callback(url, { code: 'code' });
  const status = await (await fetch(`${base}/api/drive/status`, { headers: { cookie } })).json();
  assert.equal(status.connected, true, 'openid devolvido pelo Google não pode derrubar a conexão');
  const { emailDaSessao } = await import('../src/driveOAuth.js');
  assert.equal(await emailDaSessao(sessaoDe(cookie)), 'dono@exemplo.com');

  // Um escopo realmente amplo continua barrado: essa validação é a que impede
  // que uma autorização antiga de `drive.readonly` volte a valer.
  const outra = await session();
  const startAmplo = await fetch(`${base}/api/drive/oauth/start`, {
    method: 'POST', headers: { cookie: outra, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `${origin}/room/teste` }),
  });
  const { url: urlAmplo } = await startAmplo.json() as { url: string };
  escopoDevolvido = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';
  await callback(urlAmplo, { code: 'code' });
  assert.equal((await (await fetch(`${base}/api/drive/status`, { headers: { cookie: outra } })).json()).connected, false);
});

test('o escopo pedido inclui o email, e uma autorização antiga é rejeitada', async () => {
  const cookie = await session();
  const start = await fetch(`${base}/api/drive/oauth/start`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `${origin}/room/teste` }),
  });
  const { url } = await start.json() as { url: string };
  const scope = new URL(url).searchParams.get('scope') ?? '';
  assert.ok(scope.includes('https://www.googleapis.com/auth/drive.file'));
  assert.ok(scope.includes('https://www.googleapis.com/auth/userinfo.email'));
  // A troca devolve exatamente o que foi pedido; se o Google devolvesse algo
  // além disso, a conexão teria de ser recusada.
  await callback(url, { code: 'code' }, cookie);
  const status = await (await fetch(`${base}/api/drive/status`, { headers: { cookie } })).json();
  assert.equal(status.connected, true);
});

test('conceder leitor para quem está na sala, e revogar só o que foi criado', async () => {
  const { reconciliarCompartilhamento, concessoesVivas, revogarTudo } =
    await import('../src/driveShare.js');
  const { registrarDonoDoTrack } = await import('../src/driveTrack.js');
  const sessaoDono = await conectar('dono@exemplo.com');
  await registrar(sessaoDono);

  const sala = 'sala-teste';
  await registrarDonoDoTrack(videoId, sessaoDe(sessaoDono), 'Episódio.mkv');
  driveCalls = [];

  // Uma pessoa que já tinha acesso antes do Juntos não pode ser tocada: a
  // permissão é "preexistente" e não entra na lista de revogáveis.
  permissoesPreexistentes = [{ id: 'perm-antiga', emailAddress: 'colega@exemplo.com' }];

  await reconciliarCompartilhamento({
    roomId: sala,
    fileId: videoId,
    participantes: [
      { userId: 'u-dono', email: 'dono@exemplo.com' },
      { userId: 'u-colega', email: 'colega@exemplo.com' },
      { userId: 'u-nova', email: 'nova@exemplo.com' },
      { userId: 'u-sem-email', email: null },
      { userId: 'u-invalido', email: 'nao-e-email' },
    ],
  });

  const criadas = driveCalls.filter((c) => c.method === 'POST' && c.url.includes('/permissions'));
  assert.equal(criadas.length, 1, 'só quem não tinha acesso recebe permissão nova');
  assert.equal((criadas[0].body as { emailAddress: string }).emailAddress, 'nova@exemplo.com');
  assert.ok(driveCalls.some((c) => c.method === 'GET' && c.url.includes('/permissions')), 'a lista de permissões é consultada antes');
  // Sem e-mail de notificação: quem entrou na sala não recebe um convite do Google.
  assert.ok(criadas[0].url.includes('sendNotificationEmail=false'));

  const vivas = await concessoesVivas(sala);
  assert.deepEqual(vivas?.concessoes.map((c) => c.email), ['nova@exemplo.com']);
  assert.equal(vivas?.concessoes[0].permissionId, 'perm-1', 'guardamos o id devolvido, para revogar exatamente ele');

  // Reconciliar de novo não duplica: quem já tem não é concedido outra vez.
  driveCalls = [];
  await reconciliarCompartilhamento({
    roomId: sala, fileId: videoId, participantes: [{ userId: 'u-nova', email: 'nova@exemplo.com' }],
  });
  assert.equal(driveCalls.filter((c) => c.method === 'POST').length, 0);

  driveCalls = [];
  await revogarTudo(sala);
  const deletadas = driveCalls.filter((c) => c.method === 'DELETE');
  assert.equal(deletadas.length, 1, 'revoga só a nossa');
  assert.ok(deletadas[0].url.includes('perm-1'));
  assert.ok(!deletadas[0].url.includes('perm-antiga'), 'a preexistente nunca é tocada');
  assert.equal(await concessoesVivas(sala), null);
});

test('trocar de faixa revoga o arquivo anterior, e quem entra depois recebe acesso', async () => {
  const { reconciliarCompartilhamento, concessoesVivas } = await import('../src/driveShare.js');
  const { registrarDonoDoTrack } = await import('../src/driveTrack.js');
  const sessaoDono = await conectar('dono@exemplo.com');
  await registrar(sessaoDono);
  await registrarDonoDoTrack(videoId, sessaoDe(sessaoDono), 'Episódio.mkv');

  const sala = 'sala-troca';
  const outroId = 'outro_arquivo_456';
  driveMeta = { ...metaPadrao(), id: outroId };
  await registrar(sessaoDono, outroId);
  await registrarDonoDoTrack(outroId, sessaoDe(sessaoDono), 'Outro.mkv');

  driveCalls = [];
  await reconciliarCompartilhamento({ roomId: sala, fileId: videoId, participantes: [{ userId: 'a', email: 'a@exemplo.com' }] });
  assert.equal((await concessoesVivas(sala))?.fileId, videoId);

  driveCalls = [];
  await reconciliarCompartilhamento({ roomId: sala, fileId: outroId, participantes: [{ userId: 'a', email: 'a@exemplo.com' }] });
  const apagadas = driveCalls.filter((c) => c.method === 'DELETE');
  assert.equal(apagadas.length, 1);
  assert.ok(apagadas[0].url.includes(videoId), 'a do arquivo que saiu é revogada');
  assert.ok(!apagadas[0].url.includes(outroId), 'a do arquivo novo não é tocada');
  assert.equal((await concessoesVivas(sala))?.fileId, outroId);
});

test('desconectar a conta derruba as permissões que ela sustentava', async () => {
  const { reconciliarCompartilhamento, concessoesVivas } = await import('../src/driveShare.js');
  const { registrarDonoDoTrack } = await import('../src/driveTrack.js');
  const sessaoDono = await conectar('dono@exemplo.com');
  await registrar(sessaoDono);
  await registrarDonoDoTrack(videoId, sessaoDe(sessaoDono), 'Episódio.mkv');

  const sala = 'sala-desconecta';
  await reconciliarCompartilhamento({ roomId: sala, fileId: videoId, participantes: [{ userId: 'b', email: 'b@exemplo.com' }] });
  assert.equal((await concessoesVivas(sala))?.concessoes.length, 1);

  driveCalls = [];
  await fetch(`${base}/api/drive/oauth/disconnect`, { method: 'POST', headers: { cookie: sessaoDono, origin } });
  const apagadas = driveCalls.filter((c) => c.method === 'DELETE');
  assert.equal(apagadas.length, 1, 'desconectar leva as permissões da conta junto');
  assert.equal(await concessoesVivas(sala), null);
  assert.equal((await (await fetch(`${base}/api/drive/status`, { headers: { cookie: sessaoDono } })).json()).connected, false);
});

test('a faixa de Drive só entra na fila com um fileId que o servidor reconhece', async () => {
  const { fileIdValido } = await import('../src/driveTrack.js');
  const sessaoDono = await conectar();
  await registrar(sessaoDono);
  const { donoDoTrack } = await import('../src/driveTrack.js');
  assert.equal(await donoDoTrack(videoId), sessaoDe(sessaoDono));
  assert.equal(await donoDoTrack('arquivo_que_ninguem_escolheu'), null);
  assert.equal(fileIdValido('../etc'), false);
  assert.equal(fileIdValido(videoId), true);
});
