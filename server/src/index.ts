import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { createAdapter } from '@socket.io/redis-adapter';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { createRoom, getRoom, roomCount } from './rooms.js';
import { pubClient, subClient } from './redis.js';
import { registerSocketHandlers } from './socket.js';
import {
  consumeUploadToken,
  MAX_UPLOAD_BYTES,
  publicUploadUrl,
  UPLOAD_DIR,
  uploadStorage,
  videoFileFilter,
} from './uploads.js';

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Aceita uma lista separada por vírgula, para permitir staging + produção
 * ao mesmo tempo sem precisar de duas variáveis: CLIENT_ORIGIN=https://a,https://b
 */
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

// Necessário atrás de um reverse proxy (Nginx, Caddy, load balancer) para o
// Express enxergar o IP real do cliente e o protocolo original (https),
// em vez do IP/protocolo internos do proxy.
app.set('trust proxy', 1);

app.use(cors({ origin: CLIENT_ORIGINS }));
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

/**
 * Proxy da YouTube Data API. Fica no back-end para a chave nunca ir ao browser.
 * Sem chave configurada a UI cai no modo "cole um link", que segue funcionando.
 */
app.get('/api/youtube/search', async (req, res) => {
  const key = process.env.YOUTUBE_API_KEY;
  const q = String(req.query.q ?? '').trim();
  if (!key) return res.status(501).json({ error: 'no_api_key' });
  if (!q) return res.json({ items: [] });

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', '12');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('q', q);
  url.searchParams.set('key', key);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`youtube ${response.status}`);
    const data = (await response.json()) as {
      items: { id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails: { medium?: { url: string } } } }[];
    };
    res.json({
      items: data.items.map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails.medium?.url ?? '',
      })),
    });
  } catch {
    res.status(502).json({ error: 'youtube_unavailable' });
  }
});

/**
 * Proxy de busca de GIFs. Usa Tenor se `TENOR_API_KEY` estiver definida,
 * senão cai para Giphy com `GIPHY_API_KEY`. Mesma lógica do proxy do
 * YouTube acima: a chave nunca vai ao navegador, o cliente só chama esta rota.
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

// Vídeos enviados pelos usuários. `nosniff` evita que o navegador tente
// "adivinhar" o tipo do arquivo pelo conteúdo — vale a pena já que o
// conteúdo vem de terceiros. `immutable` porque o nome do arquivo é
// aleatório e nunca é reaproveitado para outro conteúdo.
app.use(
  '/uploads',
  (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  },
  express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }),
);

const upload = multer({
  storage: uploadStorage,
  fileFilter: videoFileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * Recebe o arquivo de vídeo em si. A permissão (só host/controlador da sala)
 * já foi checada no socket ao emitir o token — aqui só validamos que o token
 * existe, não expirou e ainda não foi usado. Ver server/src/uploads.ts.
 */
app.post('/api/uploads', async (req, res) => {
  const token = String(req.query.token ?? '');
  const tokenData = await consumeUploadToken(token);
  if (!tokenData) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }

  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string; message?: string })?.code;
      const message = (err as { message?: string })?.message;
      const reason =
        code === 'LIMIT_FILE_SIZE'
          ? 'file_too_large'
          : message === 'unsupported_type'
            ? 'unsupported_type'
            : 'upload_failed';
      return res.status(400).json({ error: reason });
    }
    if (!req.file) return res.status(400).json({ error: 'missing_file' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      url: publicUploadUrl(baseUrl, req.file.filename),
      title: path.parse(req.file.originalname).name.slice(0, 120) || 'Vídeo enviado',
    });
  });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Watchparty server em http://0.0.0.0:${PORT}`);
  console.log(`Origens liberadas: ${CLIENT_ORIGINS.join(', ')}`);
});
