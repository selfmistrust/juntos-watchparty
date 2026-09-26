import type { Server, Socket } from 'socket.io';
import {
  clearRateLimit,
  isRateLimited,
  isReactionRateLimited,
  isTypingRateLimited,
  isUploadRateLimited,
  sanitizeCaption,
  sanitizeGifUrl,
  sanitizeImageDataUrl,
  sanitizeMessage,
} from './chatGuard.js';
import {
  addUser,
  canControl,
  checkPassword,
  cleanupStaleUsers,
  commitPosition,
  ensureRoom,
  getRoom,
  markUserDisconnected,
  newId,
  persistRoom,
  projectedPosition,
  removeUser,
  setUserAvatar,
  setUserColor,
  setUserName,
  snapshot,
  updateUserHeartbeat,
  PRESENCE_TIMEOUT_MS,
  CLEANUP_INTERVAL_MS,
} from './rooms.js';
import {
  ALLOWED_REACTIONS,
  ALLOWED_SOUNDS,
  CHAT_REACTION_EMOJIS,
  type ChatMessageKind,
  type ChatReactionEmoji,
  type PlaylistItem,
  type ReactionEmoji,
  type Room,
  type SoundId,
  type SystemEventKind,
} from './types.js';
import { createUploadTarget, deleteUploadIfOwned, isAllowedVideoFile, MAX_UPLOAD_BYTES } from './storage.js';
import { redis } from './redis.js';

/** Resposta do handler `upload:requestToken`, entregue via callback de ack. */
type UploadTokenAck =
  | { ok: true; uploadUrl: string; publicUrl: string; contentType: string }
  | { ok: false; error: 'no_room' | 'denied' | 'rate_limited' | 'bad_size' | 'too_large' | 'unsupported_type' };

interface JoinPayload {
  roomId: string;
  name: string;
  roomName?: string;
  password?: string;
  /** Identidade persistente do usuário (gerada no cliente, salva no localStorage). */
  userId: string;
  /** Semente do DiceBear escolhida na tela de entrada; o servidor gera uma se faltar. */
  avatarSeed?: string;
  /** Foto customizada (data URL), se o usuário já tiver enviado uma antes de entrar. */
  avatarUrl?: string;
  /** Cor de nome escolhida pelo usuário (hex), se já tiver uma salva. */
  color?: string;
}

/** Payload aceito por `chat:message`. Uma string solta ainda funciona como mensagem de texto. */
type ChatSendPayload =
  | string
  | {
      kind?: ChatMessageKind;
      text?: string;
      mediaUrl?: string;
      /** ID da mensagem original, se for uma resposta. */
      parentMessageId?: string;
    };

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    /**
     * Cada handler recarrega a sala do Redis antes de mutar: é assim que o
     * estado fica correto mesmo com várias instâncias do servidor atendendo
     * sockets diferentes da mesma sala ao mesmo tempo.
     */
    let roomId: string | null = null;

    const broadcastState = (room: Room) => {
      io.to(room.id).emit('room:state', snapshot(room));
    };

    const system = (rid: string, kind: SystemEventKind, text: string) => {
      io.to(rid).emit('room:event', { id: newId(), kind, text, at: Date.now() });
    };

    /** Rejeita a ação e devolve o estado real para o cliente voltar à linha. */
    const denied = (room: Room) => {
      socket.emit('room:denied', 'Só o host controla a reprodução nesta sala.');
      socket.emit('room:state', snapshot(room));
    };

    /** Carrega a sala atual da conexão; handlers saem cedo se não houver uma. */
    const currentRoom = () => (roomId ? getRoom(roomId) : Promise.resolve(undefined));

    socket.on(
      'room:join',
      async ({ roomId: rid, name, roomName, password, userId, avatarSeed, avatarUrl, color }: JoinPayload) => {
        const room = await ensureRoom(rid, roomName);

        const passwordOk = await checkPassword(room, password);
        if (!passwordOk) {
          socket.emit('room:join:error', {
            reason: password ? 'wrong_password' : 'password_required',
            message: password ? 'Senha incorreta.' : 'Esta tem senha.',
          });
          return;
        }

        roomId = rid;
        socket.join(rid);
        const sessionId = socket.id;
        // O `userId` é a identidade estável da pessoa. Se um cliente antigo (ou
        // adulterado) entrar sem ele, gerar um local: sem isso o `undefined`
        // batia com o `undefined` de todo mundo na hora de casar reconexões, e
        // a segunda pessoa a entrar na sala acabava ocupando o lugar da
        // primeira — inclusive sites, reações e host.
        const stableUserId =
          typeof userId === 'string' && userId.length > 0 && userId.length <= 64
            ? userId
            : newId();
        const user = addUser(room, sessionId, stableUserId, name, {
          seed: avatarSeed,
          url: avatarUrl ? sanitizeImageDataUrl(avatarUrl) ?? undefined : undefined,
        }, color);
        await persistRoom(room);
        socket.emit('room:welcome', { you: user, state: snapshot(room) });
        socket.to(rid).emit('room:state', snapshot(room));
        // Só emite evento de join se for um usuário NOVO (não reconexão)
        const isReconnect = room.users[sessionId]?.lastSeen !== undefined && room.users[sessionId].lastSeen < Date.now() - 1000;
        if (!isReconnect) {
          system(rid, 'join', `${user.name} entrou na sala`);
        }
      },
    );

    /** Cor de nome escolhida no painel de pessoas — só o próprio usuário muda a sua. */
    socket.on('user:setColor', async (color: string) => {
      const room = await currentRoom();
      if (!room) return;
      if (setUserColor(room, socket.id, color)) {
        await persistRoom(room);
        broadcastState(room);
      }
    });

    /** Nova semente de DiceBear e/ou foto customizada; `url: ''` volta pro avatar gerado. */
    socket.on('user:setAvatar', async (payload: { seed?: string; url?: string } = {}) => {
      const room = await currentRoom();
      if (!room) return;

      let url: string | undefined;
      if (payload.url) {
        const clean = sanitizeImageDataUrl(payload.url);
        if (!clean) {
          socket.emit('room:denied', 'Essa foto é grande ou inválida demais para usar como avatar.');
          return;
        }
        url = clean;
      } else if (payload.url === '') {
        url = '';
      }

      if (setUserAvatar(room, socket.id, { seed: payload.seed, url })) {
        await persistRoom(room);
        broadcastState(room);
      }
    });

    /** Nome trocado no painel de pessoas, depois de já estar na sala. */
    socket.on('user:setName', async (newName: string) => {
      const room = await currentRoom();
      if (!room) return;
      if (typeof newName !== 'string') return;
      if (setUserName(room, socket.id, newName)) {
        await persistRoom(room);
        broadcastState(room);
      }
    });

    /** Handshake de relógio: o cliente mede a latência e corrige o drift. */
    socket.on('time:ping', (clientSent: number, ack?: (t: unknown) => void) => {
      const payload = { clientSent, serverTime: Date.now() };
      if (typeof ack === 'function') ack(payload);
      else socket.emit('time:pong', payload);
    });

    /** Heartbeat de presença: atualiza lastSeen do usuário. */
    socket.on('presence:heartbeat', async () => {
      const room = await currentRoom();
      if (!room) return;
      if (updateUserHeartbeat(room, socket.id)) {
        await persistRoom(room);
      }
    });

    socket.on('player:play', async (at?: number) => {
      const room = await currentRoom();
      if (!room) return;
      if (!canControl(room, socket.id)) return denied(room);
      commitPosition(room, at);
      room.isPlaying = true;
      await persistRoom(room);
      broadcastState(room);
      system(room.id, 'play', `${room.users[socket.id]?.name ?? 'Alguém'} deu play`);
    });

    socket.on('player:pause', async (at?: number) => {
      const room = await currentRoom();
      if (!room) return;
      if (!canControl(room, socket.id)) return denied(room);
      commitPosition(room, at);
      room.isPlaying = false;
      await persistRoom(room);
      broadcastState(room);
      system(room.id, 'pause', `${room.users[socket.id]?.name ?? 'Alguém'} pausou`);
    });

    socket.on('player:seek', async (to: number) => {
      const room = await currentRoom();
      if (!room) return;
      if (!canControl(room, socket.id)) return denied(room);
      commitPosition(room, Math.max(0, to));
      await persistRoom(room);
      broadcastState(room);
      system(room.id, 'seek', `${room.users[socket.id]?.name ?? 'Alguém'} mudou o ponto do vídeo`);
    });

    /** Só o cliente do host reporta o fim para evitar N avanços simultâneos. */
    socket.on('player:ended', async () => {
      const room = await currentRoom();
      if (!room || room.hostId !== socket.id) return;
      advance(room);
      await persistRoom(room);
      broadcastState(room);
    });

    socket.on('playlist:add', async (item: Omit<PlaylistItem, 'id' | 'addedBy'>) => {
      const room = await currentRoom();
      if (!room) return;
      const user = room.users[socket.id];
      const entry: PlaylistItem = {
        ...item,
        id: newId(),
        addedBy: user?.name ?? 'Convidado',
        addedById: user?.userId ?? '',
      };
      room.playlist.push(entry);
      if (room.currentIndex === -1) {
        room.currentIndex = 0;
        commitPosition(room, 0);
      }
      await persistRoom(room);
      broadcastState(room);
      system(room.id, 'track', `${entry.addedBy} adicionou "${entry.title}"`);
    });

    /**
     * Autoriza o upload de um vídeo — mas quem recebe o arquivo não é o
     * nosso servidor, é o bucket S3/R2 diretamente. Aqui a gente só checa
     * permissão (`canControl`, mais restrito que `playlist:add` por
     * link/busca) e devolve uma URL assinada de PUT que só serve pra este
     * objeto específico, por um tempo limitado. O vídeo nunca passa pelo
     * nosso processo — sem isso, um host de graça com timeout curto (ex.:
     * Render free tier) derrubaria qualquer envio de arquivo grande.
     */
    socket.on(
      'upload:requestToken',
      async (
        payload: { fileName?: string; fileSize?: number; mimeType?: string } = {},
        ack?: (res: UploadTokenAck) => void,
      ) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const room = await currentRoom();
        if (!room) return reply({ ok: false, error: 'no_room' });
        if (!canControl(room, socket.id)) return reply({ ok: false, error: 'denied' });
        if (isUploadRateLimited(socket.id)) return reply({ ok: false, error: 'rate_limited' });

        const size = Number(payload.fileSize);
        if (!Number.isFinite(size) || size <= 0) return reply({ ok: false, error: 'bad_size' });
        if (size > MAX_UPLOAD_BYTES) return reply({ ok: false, error: 'too_large' });
        const fileName = String(payload.fileName ?? '');
        if (!isAllowedVideoFile(fileName, String(payload.mimeType ?? ''))) {
          return reply({ ok: false, error: 'unsupported_type' });
        }

        // Aqui a gente confia no tamanho que o cliente declarou — uma URL
        // assinada de PUT não tem como travar um Content-Length máximo
        // (isso exigiria presigned POST com policy, bem mais complexo pro
        // ganho). Pra uso entre amigos/confiável isso é aceitável; num
        // cenário público valeria a pena migrar pra presigned POST.
        const target = await createUploadTarget(fileName);
        reply({ ok: true, uploadUrl: target.uploadUrl, publicUrl: target.publicUrl, contentType: target.contentType });
      },
    );

    socket.on('playlist:remove', async (itemId: string) => {
      const room = await currentRoom();
      if (!room) return;
      if (!canControl(room, socket.id)) return denied(room);
      const index = room.playlist.findIndex((i) => i.id === itemId);
      if (index === -1) return;
      const [removed] = room.playlist.splice(index, 1);
      if (removed?.kind === 'file') void deleteUploadIfOwned(removed.src);
      if (index < room.currentIndex) room.currentIndex -= 1;
      else if (index === room.currentIndex) {
        room.currentIndex = Math.min(room.currentIndex, room.playlist.length - 1);
        commitPosition(room, 0);
        room.isPlaying = false;
      }
      await persistRoom(room);
      broadcastState(room);
    });

    socket.on('playlist:reorder', async ({ from, to }: { from: number; to: number }) => {
      const room = await currentRoom();
      if (!room) return;
      if (!canControl(room, socket.id)) return denied(room);
      const { playlist } = room;
      if (from < 0 || from >= playlist.length || to < 0 || to >= playlist.length) return;
      const playingId = room.playlist[room.currentIndex]?.id;
      const [moved] = playlist.splice(from, 1);
      playlist.splice(to, 0, moved);
      if (playingId) room.currentIndex = playlist.findIndex((i) => i.id === playingId);
      await persistRoom(room);
      broadcastState(room);
    });

    socket.on('playlist:select', async (index: number) => {
      const room = await currentRoom();
      if (!room) return;
      if (!canControl(room, socket.id)) return denied(room);
      if (index < 0 || index >= room.playlist.length) return;
      room.currentIndex = index;
      commitPosition(room, 0);
      room.isPlaying = true;
      await persistRoom(room);
      broadcastState(room);
      system(room.id, 'track', `Tocando agora: ${room.playlist[index].title}`);
    });

    socket.on('room:setOpenControl', async (open: boolean) => {
      const room = await currentRoom();
      if (!room || room.hostId !== socket.id) return;
      room.openControl = Boolean(open);
      await persistRoom(room);
      broadcastState(room);
      system(
        room.id,
        'host',
        room.openControl
          ? 'O host liberou os controles para todo mundo'
          : 'O host voltou a controlar a reprodução',
      );
    });

    /** Reação flutuante sobre o vídeo. Efêmera: não entra no estado persistido da sala. */
    socket.on('reaction:send', async (emoji: string) => {
      const room = await currentRoom();
      const user = room?.users[socket.id];
      if (!room || !user) return;
      if (!ALLOWED_REACTIONS.includes(emoji as ReactionEmoji)) return;
      if (isReactionRateLimited(socket.id)) return;

      io.to(room.id).emit('reaction:new', {
        id: newId(),
        emoji,
        userId: user.sessionId,
        name: user.name,
      });
    });

    /** Efeito sonoro rápido — cada cliente sintetiza o áudio localmente ao receber. */
    socket.on('sound:trigger', async (soundId: string) => {
      const room = await currentRoom();
      const user = room?.users[socket.id];
      if (!room || !user) return;
      if (!ALLOWED_SOUNDS.includes(soundId as SoundId)) return;
      if (isReactionRateLimited(socket.id)) return;

      io.to(room.id).emit('sound:play', {
        id: newId(),
        soundId,
        userId: user.sessionId,
        name: user.name,
      });
    });

    socket.on('chat:message', async (payload: ChatSendPayload) => {
      const room = await currentRoom();
      const user = room?.users[socket.id];
      if (!room || !user) return;

      if (isRateLimited(socket.id)) {
        socket.emit('room:denied', 'Calma aí — espera um instante antes de mandar outra mensagem.');
        return;
      }

      // Compatibilidade: uma string solta ainda é tratada como mensagem de texto.
      const raw = typeof payload === 'string' ? { kind: 'text' as const, text: payload } : payload ?? {};
      const kind: ChatMessageKind = raw.kind ?? 'text';

      let text = '';
      let mediaUrl: string | undefined;
      let parentMessageId: string | undefined;
      let parentMessagePreview: { id: string; name: string; text: string } | undefined;

      if (kind === 'text') {
        const clean = sanitizeMessage(raw.text ?? '');
        if (!clean) return;
        text = clean;
        // Guarda o id da mensagem respondida; o preview é montado abaixo,
        // depois que a lista de mensagens da sala já está carregada.
        if (typeof payload === 'object' && payload?.parentMessageId) {
          parentMessageId = String(payload.parentMessageId);
        }
      } else if (kind === 'gif') {
        const url = sanitizeGifUrl(raw.mediaUrl);
        if (!url) return;
        mediaUrl = url;
        text = sanitizeCaption(raw.text);
      } else if (kind === 'image') {
        const url = sanitizeImageDataUrl(raw.mediaUrl);
        if (!url) {
          socket.emit('room:denied', 'Essa imagem é grande ou inválida demais para enviar.');
          return;
        }
        mediaUrl = url;
        text = sanitizeCaption(raw.text);
      } else {
        return;
      }

      const messageId = newId();
      const now = Date.now();

      // Se há parentMessageId, busca a mensagem original no feed do Redis (simplificado: procuramos na sala)
      // Para simplificar, armazenamos mensagens recentes na sala
      if (!room.messages) room.messages = [];
      const parentMsg = parentMessageId ? room.messages.find((m: any) => m.id === parentMessageId) : undefined;

      const message = {
        id: messageId,
        userId: user.sessionId,
        name: user.name,
        color: user.color,
        kind,
        text,
        mediaUrl,
        at: now,
        parentMessageId,
        parentMessagePreview: parentMsg ? {
          id: parentMsg.id,
          name: parentMsg.name,
          text: parentMsg.kind === 'text' ? parentMsg.text : parentMsg.kind === 'gif' ? '[GIF] ' + (parentMsg.text || parentMsg.mediaUrl || '') : '[Imagem]'
        } : undefined,
        reactions: {},
      };

      room.messages.push(message);
      // Mantém apenas últimas 500 mensagens
      if (room.messages.length > 500) room.messages = room.messages.slice(-500);

      await persistRoom(room);
      io.to(room.id).emit('chat:message', message);
    });

    // Reação a mensagem
    socket.on('chat:reaction:add', async (payload: unknown) => {
      const { messageId, emoji } = (payload ?? {}) as { messageId?: unknown; emoji?: unknown };
      if (typeof messageId !== 'string' || !messageId) return;
      if (typeof emoji !== 'string' || !CHAT_REACTION_EMOJIS.includes(emoji as any)) return;

      const room = await currentRoom();
      const user = room?.users[socket.id];
      if (!room || !user) return;

      if (isReactionRateLimited(socket.id)) return;

      if (!room.messages) return;
      const msg = room.messages.find((m: any) => m.id === messageId);
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = { count: 0, users: [] };
      // Guarda o `userId` persistente, não o `sessionId`: se fosse o id do
      // socket, um F5 trocaria a identidade e a pessoa perderia o destaque da
      // própria reação (e poderia reagir de novo sem querer).
      if (msg.reactions[emoji].users.includes(user.userId)) return; // Já reagiu

      msg.reactions[emoji].count += 1;
      msg.reactions[emoji].users.push(user.userId);

      await persistRoom(room);
      io.to(room.id).emit('chat:reaction:add', { messageId, emoji, userId: user.userId });
    });

    // Remover reação
    socket.on('chat:reaction:remove', async (payload: unknown) => {
      const { messageId, emoji } = (payload ?? {}) as { messageId?: unknown; emoji?: unknown };
      if (typeof messageId !== 'string' || !messageId) return;
      if (typeof emoji !== 'string' || !CHAT_REACTION_EMOJIS.includes(emoji as any)) return;

      const room = await currentRoom();
      const user = room?.users[socket.id];
      if (!room || !user) return;

      if (isReactionRateLimited(socket.id)) return;

      if (!room.messages) return;
      const msg = room.messages.find((m: any) => m.id === messageId);
      if (!msg || !msg.reactions?.[emoji]) return;
      if (!msg.reactions[emoji].users.includes(user.userId)) return; // Não reagiu

      msg.reactions[emoji].count -= 1;
      msg.reactions[emoji].users = msg.reactions[emoji].users.filter((u: string) => u !== user.userId);
      if (msg.reactions[emoji].count === 0) delete msg.reactions[emoji];

      await persistRoom(room);
      io.to(room.id).emit('chat:reaction:remove', { messageId, emoji, userId: user.userId });
    });

    socket.on('chat:typing', async (isTyping: boolean) => {
      const room = await currentRoom();
      const user = room?.users[socket.id];
      if (!room || !user) return;
      if (isTypingRateLimited(socket.id)) return;
      socket.to(room.id).emit('chat:typing', { id: user.sessionId, name: user.name, isTyping: Boolean(isTyping) });
    });

    socket.on('disconnect', async () => {
      clearRateLimit(socket.id);
      const room = await currentRoom();
      if (!room) return;
      const user = markUserDisconnected(room, socket.id);
      if (user) {
        system(room.id, 'leave', `${user.name} saiu da sala`);
        // Sem isso, quem estava digitando na hora de cair a conexão (aba
        // fechada, wi-fi caiu) deixaria o indicador travado pros outros pra
        // sempre — o timeout de "parou de digitar" do cliente nunca dispara
        // porque o cliente já não está mais lá pra disparar nada.
        socket.to(room.id).emit('chat:typing', { id: user.sessionId, name: user.name, isTyping: false });
      }
      // Se não há usuários conectados, congela o tempo
      const connectedUsers = Object.values(room.users).filter(u => u.connected);
      if (connectedUsers.length === 0) {
        commitPosition(room, projectedPosition(room));
        room.isPlaying = false;
      }
      await persistRoom(room);
      broadcastState(room);
      roomId = null;
    });
  });
}

function advance(room: Room) {
  if (room.currentIndex < room.playlist.length - 1) {
    room.currentIndex += 1;
    commitPosition(room, 0);
    room.isPlaying = true;
  } else {
    commitPosition(room, 0);
    room.isPlaying = false;
  }
}

/**
 * Inicia job periódico de limpeza de sessões abandonadas.
 * Remove usuários desconectados há mais de PRESENCE_TIMEOUT_MS.
 */
export function startPresenceCleanup(io: Server): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const keys = await redis.keys('room:*');
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        let room: Room;
        try {
          room = JSON.parse(raw) as Room;
        } catch {
          continue;
        }
        const removed = cleanupStaleUsers(room);
        if (removed.length > 0) {
          await persistRoom(room);
          io.to(room.id).emit('room:state', snapshot(room));
          for (const user of removed) {
            io.to(room.id).emit('room:event', {
              id: newId(),
              kind: 'leave',
              text: `${user.name} foi removido por inatividade`,
              at: Date.now(),
            });
          }
        }
      }
    } catch (err) {
      console.error('[presence-cleanup] erro:', err);
    }
  }, CLEANUP_INTERVAL_MS);
}
