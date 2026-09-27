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

const realFetch = globalThis.fetch;
let exchanges: URLSearchParams[] = [];
let tokenFailure = false;
type DriveCall = { url: string; range: string | null; auth: string | null };
let driveCalls: DriveCall[] = [];
let driveMeta: Record<string, unknown> | null = null;
let mediaStatus = 200;
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
 * O Drive é simulado no limite do que a rota realmente depende: os metadados
 * (com `canDownload`, que a documentação manda checar) e os bytes, que precisam
 * respeitar `Range` como o Google respeita. Sem isso o teste passaria mesmo com a
 * rota ignorando o cabeçalho.
 */
function responderDrive(url: URL, init: RequestInit | undefined): Response {
  const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
  driveCalls.push({ url: url.toString(), range, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
  if (url.searchParams.get('alt') === 'media') {
    if (mediaStatus !== 200) return new Response('{}', { status: mediaStatus });
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
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
    return tokenFailure
      ? new Response('{}', { status: 503 })
      : Response.json({
        access_token: 'test-access-token', refresh_token: 'test-refresh-token',
        expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file',
      });
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
  exchanges = [];
  tokenFailure = false;
  driveCalls = [];
  driveMeta = metaPadrao();
  mediaStatus = 200;
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
  assert.equal(google.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
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
  tokenFailure = true;
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

// --- Reprodução: a rota de stream -------------------------------------------

async function conectar(): Promise<string> {
  const cookie = await session();
  const start = await fetch(`${base}/api/drive/oauth/start`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `${origin}/room/teste` }),
  });
  const { url } = await start.json() as { url: string };
  await callback(url, { code: 'code' }, cookie);
  return cookie;
}

async function conceder(cookie: string, fileId = videoId) {
  const res = await fetch(`${base}/api/drive/stream-token`, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  });
  return res;
}

test('a concessão devolve um caminho opaco e o nome do arquivo, sem baixar nada', async () => {
  const cookie = await conectar();
  const res = await conceder(cookie);
  assert.equal(res.status, 200);
  const target = await res.json() as { path: string; token: string; name: string; duration?: number; size?: number };
  assert.match(target.path, /^\/api\/drive\/stream\/[a-z0-9]{32}$/);
  assert.equal(target.name, 'Episódio.mkv');
  assert.equal(target.duration, 15);
  assert.equal(target.size, MEDIA.length);
  // A resposta não carrega o id do Drive: o `src` da fila é o token, e nada
  // mais do arquivo do usuário atravessa o servidor nessa resposta.
  assert.doesNotMatch(JSON.stringify(target), new RegExp(videoId));
  assert.ok(!driveCalls.some((c) => c.url.includes('alt=media')), 'conceder não baixa o arquivo');
});

test('a concessão recusa quem não tem conta, id inválido, não-vídeo e download bloqueado', async () => {
  const semConta = await session();
  assert.equal((await conceder(semConta)).status, 401);

  const cookie = await conectar();
  assert.equal((await conceder(cookie, '../../etc/passwd')).status, 400);

  driveMeta = { ...metaPadrao(), mimeType: 'application/pdf' };
  assert.equal((await conceder(cookie)).status, 422);

  driveMeta = { ...metaPadrao(), capabilities: { canDownload: false } };
  assert.equal((await conceder(cookie)).status, 422);

  driveMeta = null;
  assert.equal((await conceder(cookie)).status, 502);
});

test('a rota de stream serve 206 com o intervalo pedido, e o Range chega no Drive', async () => {
  const cookie = await conectar();
  const { path: streamPath } = await (await conceder(cookie)).json() as { path: string };

  const res = await fetch(`${base}${streamPath}`, { headers: { Range: 'bytes=4-7' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-range'), `bytes 4-7/${MEDIA.length}`);
  assert.equal(res.headers.get('content-type'), 'video/x-matroska');
  assert.equal(await res.text(), '4567');

  const media = driveCalls.filter((c) => c.url.includes('alt=media'));
  assert.equal(media.length, 1);
  assert.equal(media[0].range, 'bytes=4-7', 'o Range do <video> tem de ser repassado');
  assert.equal(media[0].auth, 'Bearer test-access-token', 'o stream usa o token de quem concedeu');
  assert.ok(media[0].url.includes(videoId), 'a URL do Drive é montada pelo servidor, a partir do id validado');
});

test('sem Range a rota responde o arquivo inteiro, e seeks sucessivos somam os intervalos', async () => {
  const cookie = await conectar();
  const { path: streamPath } = await (await conceder(cookie)).json() as { path: string };

  const inteiro = await fetch(`${base}${streamPath}`);
  assert.equal(inteiro.status, 200);
  assert.equal((await inteiro.arrayBuffer()).byteLength, MEDIA.length);

  for (const [range, esperado] of [['bytes=0-3', '0123'], ['bytes=8-15', '89abcdef'], ['bytes=12-', 'cdef']] as const) {
    const res = await fetch(`${base}${streamPath}`, { headers: { Range: range } });
    assert.equal(res.status, 206, range);
    assert.equal(await res.text(), esperado);
  }
  assert.equal(driveCalls.filter((c) => c.url.includes('alt=media')).length, 4);
});

test('Range malformado ou múltiplo não é repassado, e token desconhecido dá 404', async () => {
  const cookie = await conectar();
  const { path: streamPath } = await (await conceder(cookie)).json() as { path: string };

  const multiplo = await fetch(`${base}${streamPath}`, { headers: { Range: 'bytes=0-3,6-9' } });
  assert.equal(multiplo.status, 200, 'sem intervalo reconhecido o Drive responde o arquivo inteiro');
  assert.equal(driveCalls.filter((c) => c.url.includes('alt=media')).at(-1)?.range, null);

  for (const token of ['inexistente', '../../api/drive/status', 'a'.repeat(31), 'A'.repeat(32)]) {
    assert.equal((await fetch(`${base}/api/drive/stream/${token}`)).status, 404, token);
  }
  assert.equal((await fetch(`${base}/api/drive/stream/${streamPath.split('/').pop()}`)).status, 200);
});

test('a rota de mídia não exige Origin — é o que o <video> realmente manda', async () => {
  const cookie = await conectar();
  const { path: streamPath } = await (await conceder(cookie)).json() as { path: string };
  const semOrigin = await fetch(`${base}${streamPath}`, { headers: { Range: 'bytes=0-1' } });
  assert.equal(semOrigin.status, 206);
  await semOrigin.text();
});

test('a reprodução morre junto com a concessão, e o erro do Drive não vaza HTML', async () => {
  const cookie = await conectar();
  const { path: streamPath } = await (await conceder(cookie)).json() as { path: string };
  const token = streamPath.split('/').pop() as string;

  mediaStatus = 403;
  const negado = await fetch(`${base}${streamPath}`);
  assert.equal(negado.status, 502);
  assert.match(negado.headers.get('content-type') ?? '', /application\/json/);

  // Desconectar apaga a concessão; a faixa na sala deixa de ter de onde tirar.
  mediaStatus = 200;
  await fetch(`${base}/api/drive/oauth/disconnect`, { method: 'POST', headers: { cookie, origin } });
  assert.equal((await fetch(`${base}${streamPath}`, { headers: { Range: 'bytes=0-1' } })).status, 404);
  assert.ok(!entries.has(`drive:stream:${token}`), 'desconectar apaga a concessão, não só a torna inerte');
});

test('só um src de stream bem formado é tratado como concessão do servidor', async () => {
  const { extrairTokenDeSrc } = await import('../src/driveStream.js');
  const cookie = await conectar();
  const { path: streamPath, token } = await (await conceder(cookie)).json() as { path: string; token: string };

  // O `src` da fila é uma URL absoluta, e é assim que volta para o servidor.
  assert.equal(extrairTokenDeSrc(`https://juntos-watchparty.onrender.com${streamPath}`), token);
  assert.equal(extrairTokenDeSrc(`http://localhost:4001${streamPath}?x=1`), token);

  // URLs de envio comum e de terceiros não passam pela validação: elas não são
  // buscadas pelo servidor, são apenas o `src` de um `<video>`.
  for (const src of [
    'https://pub-30c89b6c11c047cdb31775970b9407b2.r2.dev/uploads/abcdefghijklmnopqrstuv.mp4',
    'https://youtu.be/abc',
    '',
  ]) {
    assert.equal(extrairTokenDeSrc(src), null, src);
  }

  // Um caminho de stream com token fora do formato não passa como concessão:
  // a rota de mídia só procura no Redis, então o resultado é 404, nunca busca.
  for (const src of [
    `https://api.example/api/drive/stream/../../status`,
    `https://api.example/api/drive/stream/${'A'.repeat(32)}`,
    `https://api.example/api/drive/stream/${'a'.repeat(31)}`,
  ]) {
    assert.equal(extrairTokenDeSrc(src), null, src);
  }
  assert.equal(extrairTokenDeSrc(null), null);

  /*
   * Um caminho bem formado apontando para outro host continua sendo reconhecido,
   * e isso é intencional: o servidor não tem como saber o próprio endereço
   * público, e também não importa. A rota de mídia só existe em
   * `/api/drive/stream/:token` e resolve o token no Redis — nunca busca a URL
   * que o cliente mandou. No máximo, o `src` de um `<video>` aponta para fora.
   */
  assert.equal(extrairTokenDeSrc(`https://exemplo.com/api/drive/stream/${token}`), token);
});
