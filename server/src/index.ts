import 'dotenv/config';
import http from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { createRoom, getRoom, roomCount } from './rooms.js';
import { pubClient, subClient } from './redis.js';
import { registerSocketHandlers, startPresenceCleanup } from './socket.js';
import { scheduleUploadCleanup } from './uploadCleanup.js';
import { registerYoutubeRoutes } from './youtubeRoutes.js';

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Aceita uma lista separada por vírgula, para permitir staging + produção
 * ao mesmo tempo sem precisar de duas variáveis: CLIENT_ORIGIN=https://a,https://b
 */
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

// Necessário atrás de um reverse proxy (Nginx, Caddy, load balancer) para o
// Express enxergar o IP real do cliente e o protocolo original (https),
// em vez do IP/protocolo internos do proxy.
app.set('trust proxy', 1);

app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));
app.use(express.json());

app.get('/health', async (_req, res) => {
  res.json({ ok: true, rooms: await roomCount(), uptime: process.uptime() });
});

app.post('/api/rooms', async (req, res) => {
  const room = await createRoom(req.body?.name, req.body?.password);
  res.status(201).json({ id: room.id, name: room.name, hasPassword: Boolean(room.passwordHash) });
});

app.get('/api/rooms/:id', async (req, res) => {
  const room = await getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: room.id,
    name: room.name,
    users: Object.keys(room.users).length,
    hasPassword: Boolean(room.passwordHash),
  });
});

registerYoutubeRoutes(app);

/**
 * Proxy de busca de GIFs. Usa Tenor se `TENOR_API_KEY` estiver definida,
 * senão cai para Giphy com `GIPHY_API_KEY`. A chave nunca vai ao navegador.
 * Sem nenhuma chave configurada, a UI esconde a busca de GIF automaticamente.
 */
app.get('/api/gifs/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ items: [] });

  const tenorKey = process.env.TENOR_API_KEY;
  const giphyKey = process.env.GIPHY_API_KEY;

  try {
    if (tenorKey) {
      const url = new URL('https://tenor.googleapis.com/v2/search');
      url.searchParams.set('q', q);
      url.searchParams.set('key', tenorKey);
      url.searchParams.set('client_key', 'juntos_watchparty');
      url.searchParams.set('limit', '24');
      url.searchParams.set('media_filter', 'gif,tinygif');

      const response = await fetch(url);
      if (!response.ok) throw new Error(`tenor ${response.status}`);
      const data = (await response.json()) as {
        results: {
          id: string;
          content_description: string;
          media_formats: { gif?: { url: string }; tinygif?: { url: string } };
        }[];
      };

      return res.json({
        items: data.results.map((r) => ({
          id: r.id,
          title: r.content_description || 'GIF',
          preview: r.media_formats.tinygif?.url ?? r.media_formats.gif?.url ?? '',
          url: r.media_formats.gif?.url ?? r.media_formats.tinygif?.url ?? '',
        })),
      });
    }

    if (giphyKey) {
      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.searchParams.set('q', q);
      url.searchParams.set('api_key', giphyKey);
      url.searchParams.set('limit', '24');
      url.searchParams.set('rating', 'pg-13');

      const response = await fetch(url);
      if (!response.ok) throw new Error(`giphy ${response.status}`);
      const data = (await response.json()) as {
        data: {
          id: string;
          title: string;
          images: { fixed_height?: { url: string }; fixed_height_small?: { url: string } };
        }[];
      };

      return res.json({
        items: data.data.map((g) => ({
          id: g.id,
          title: g.title || 'GIF',
          preview: g.images.fixed_height_small?.url ?? g.images.fixed_height?.url ?? '',
          url: g.images.fixed_height?.url ?? g.images.fixed_height_small?.url ?? '',
        })),
      });
    }

    return res.status(501).json({ error: 'no_api_key' });
  } catch {
    res.status(502).json({ error: 'gif_provider_unavailable' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGINS, methods: ['GET', 'POST'] },
  // Padrão do Socket.io é 1 MB; imagens de chat (já comprimidas no cliente,
  // teto de ~500 KB em base64) precisam de uma folga sobre isso.
  maxHttpBufferSize: 2 * 1024 * 1024,
});

// A partir daqui, qualquer instância do servidor entrega broadcasts
// (chat, play/pause) para sockets conectados em qualquer outra instância,
// desde que todas apontem para o mesmo Redis.
io.adapter(createAdapter(pubClient, subClient));

registerSocketHandlers(io);

// Inicia limpeza periódica de sessões abandonadas
startPresenceCleanup(io);

server.listen(PORT, () => {
  console.log(`Watchparty server em http://localhost:${PORT}`);
  console.log(`Origens liberadas: ${CLIENT_ORIGINS.join(', ')}`);
});

// Limpeza periódica de vídeos enviados que não estão mais na fila de
// nenhuma sala ativa — ver server/src/uploadCleanup.ts.
scheduleUploadCleanup();
