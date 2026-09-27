import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';

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
