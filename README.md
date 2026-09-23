# juntos — plataforma de watchparty

Salas de vídeo sincronizado com chat em tempo real e fila colaborativa. Next.js + TypeScript +
Tailwind no cliente, Node/Express + Socket.io no servidor.

---

## 1. Estrutura de pastas

```
watchparty/
├─ server/                        Node + Express + Socket.io (estado autoritativo)
│  ├─ src/
│  │  ├─ index.ts                 HTTP, CORS, rotas REST, proxy da YouTube API
│  │  ├─ socket.ts                Handlers de sincronia, chat e fila
│  │  ├─ rooms.ts                 Store em memória + projeção de posição do vídeo
│  │  └─ types.ts
│  ├─ .env
│  └─ package.json
│
└─ web/                           Next.js (Pages Router)
   ├─ pages/
   │  ├─ _app.tsx                 Fontes, CSS global, metadados
   │  ├─ index.tsx                Landing: criar sala / entrar por código
   │  └─ room/[id].tsx            Sala: header + palco + sidebar
   ├─ components/
   │  ├─ player/
   │  │  ├─ VideoStage.tsx        Orquestra player, sincronia e auto-hide
   │  │  ├─ YoutubePlayer.tsx     IFrame API encapsulada em PlayerHandle
   │  │  ├─ FilePlayer.tsx        <video> com a mesma PlayerHandle
   │  │  └─ PlayerControls.tsx    Barra inferior sobreposta
   │  ├─ chat/ChatPanel.tsx
   │  ├─ playlist/PlaylistPanel.tsx
   │  ├─ people/PeoplePanel.tsx
   │  ├─ ui/{Button,Tabs,Avatar}.tsx
   │  ├─ Sidebar.tsx              Abas Chat / Fila / Pessoas (drawer no mobile)
   │  ├─ RoomHeader.tsx
   │  └─ JoinGate.tsx
   ├─ hooks/useRoom.ts            Conexão, estado, ações, offset de relógio
   ├─ lib/{socket,media,youtubeApi}.ts
   ├─ styles/globals.css
   ├─ types/index.ts
   └─ tailwind.config.ts          Design tokens
```

Regra de dependência: os componentes não falam com o socket, tudo passa por `useRoom`, que devolve
estado somente-leitura e um objeto `actions`. Isso mantém a UI testável e evita eventos duplicados.

---

## 2. Design system

| Token | Valor | Uso |
| --- | --- | --- |
| `canvas` | `#08080A` | fundo da aplicação |
| `surface` | `#101014` | sidebar, cartões |
| `raised` | `#17171C` | inputs, botões secundários |
| `hover` | `#1E1E25` | estado de hover em listas |
| `hairline` | `rgba(255,255,255,.07)` | todas as divisórias |
| `accent` | `#7C5CFF` | ação primária, foco, faixa tocando |
| `live` | `#FF4D6D` | indicador de sala ao vivo, remover |

Texto em três níveis (`ink`, `ink-muted`, `ink-faint`) para criar hierarquia sem usar mais cores.

**Tipografia**

Bricolage Grotesque nos títulos, Inter na interface, mono tabular para tempo e
código da sala.

**Princípios aplicados**

- O accent só marca ação, foco e estado ao vivo.
- Animação responde a gesto: hover, abrir gaveta, aparecer mensagem. A única animação
  automática é o pulso do indicador ao vivo e a convergência da linha do tempo na home.
- Controles do player somem após 2,8 s de mouse parado e voltam na hora em que o vídeo pausa.
- `prefers-reduced-motion` desliga tudo, e o foco de teclado tem anel visível em qualquer fundo.

**Responsividade**

Abaixo de 1024 px o vídeo vai para o topo em 16:9 e a sidebar vira uma gaveta
sobre a tela; acima disso, grid de duas colunas com painel fixo de 23 rem.

---

## 3. Como a sincronização funciona

Cada sala guarda `position` (segundos) e `updatedAt` (timestamp de quando aquela posição valia). Quem chega depois recebe a posição **projetada**:

```
posição_agora = tocando ? position + (agora - updatedAt) / 1000 : position
```

No cliente:

1. **Offset de relógio.** A cada 15 s o `useRoom` faz um ping com ack e calcula
   `serverTime + rtt/2 - Date.now()`. Sem isso, um relógio local adiantado bagunça a conta.
2. **Correção de deriva** (`VideoStage`, a cada 1,2 s):
   - diferença acima de **1,5 s** → `seek` direto;
   - entre **0,35 s e 1,5 s** → `playbackRate` vai a 1,08 ou 0,92 e o atraso é absorvido em
     poucos segundos, sem salto visível nem distorção audível;
   - abaixo de 0,35 s → volta a 1,0.
3. **Autoridade.** Play, pause, seek, reordenar e remover exigem host, a menos que o host ligue
   "todos podem controlar". Uma ação negada devolve `room:denied` e o snapshot atual, então o
   cliente rebelde volta imediatamente para a linha.
4. **Fim do vídeo.** Só o cliente do host emite `player:ended`, para a fila não pular N faixas.
5. **Sala vazia.** O tempo congela quando o último participante sai; a sala é descartada após
   10 minutos.

### Protocolo de eventos

| Cliente → Servidor | Payload |
| --- | --- |
| `room:join` | `{ roomId, name, password?, avatarSeed?, avatarUrl? }` |
| `time:ping` | `clientSent` (com ack) |
| `player:play` / `player:pause` | `segundos?` |
| `player:seek` | `segundos` |
| `player:ended` | — |
| `playlist:add` | `{ kind, src, title, thumbnail? }` |
| `playlist:remove` | `itemId` |
| `playlist:reorder` | `{ from, to }` |
| `playlist:select` | `index` |
| `room:setOpenControl` | `boolean` |
| `chat:message` | `{ kind: 'text' \| 'gif' \| 'image', text?, mediaUrl? }` (string solta ainda funciona como texto) |
| `chat:typing` | `boolean` |
| `user:setColor` | `"#rrggbb"` |
| `user:setAvatar` | `{ seed?, url? }` (`url: ''` volta pro avatar gerado) |
| `reaction:send` | um dos emojis de `ALLOWED_REACTIONS` |
| `sound:trigger` | um dos ids de `ALLOWED_SOUNDS` |

| Servidor → Cliente | Payload |
| --- | --- |
| `room:welcome` | `{ you, state }` |
| `room:join:error` | `{ reason: 'password_required' \| 'wrong_password', message }` |
| `room:state` | snapshot completo (posição já projetada, inclui `hasPassword`) |
| `room:event` | aviso de sistema (entrou, pausou, trocou de faixa) |
| `room:denied` | mensagem de permissão (inclui recusa por rate limit e mídia inválida) |
| `chat:message` | mensagem com cor, `kind` e `mediaUrl` quando for gif/imagem |
| `chat:typing` | `{ id, name, isTyping }` |
| `reaction:new` | `{ id, emoji, userId, name }` — dispara a animação flutuante |
| `sound:play` | `{ id, soundId, userId, name }` — cada cliente sintetiza o áudio localmente |

---

## 4. Rodando localmente

Requisitos: Node 18.17 ou superior + Redis (responsável por guardar o estado das salas).

**Terminal 1 — Redis**

A forma mais simples é via Docker:

```bash
docker run --name watchparty-redis -p 6379:6379 -d redis:7-alpine
```

Caso não tenha o Docker, instale o Redis nativamente ([redis.io/docs/getting-started](https://redis.io/docs/getting-started))

No Windows, use o WSL, pois não há build oficial para o Windows puro.

**Terminal 2 — servidor**

```bash
cd server
npm install
cp .env.example .env
npm run dev          # http://localhost:4001
```

**Terminal 3 — cliente**

```bash
cd web
npm install
cp .env.local.example .env.local
npm run dev          # http://localhost:3001
```

Abra `http://localhost:3001`, clique em "Criar uma sala" e cole o link em outra janela anônima
para ver a sincronia funcionando entre duas sessões.

### Busca no YouTube (opcional)

A aba Fila aceita links do YouTube e `.mp4` sem nenhuma configuração. Para habilitar a busca por
texto, crie uma chave da **YouTube Data API v3** no Google Cloud Console e coloque em
`server/.env`:

```
YOUTUBE_API_KEY=sua_chave.
```

A chave fica só no servidor, o cliente chama por `/api/youtube/search`

### Reações, sons, avatares e GIFs (novidades desta versão)

Quatro recursos novos:

- **Reações flutuantes.** O dock no canto do player manda `❤️ 😂 😱 🔥 👏` (lista fechada em
  `ALLOWED_REACTIONS`, tanto no servidor quanto no cliente). O servidor só retransmite pro resto
  da sala — a posição horizontal e a duração da animação são sorteadas em `useRoom.ts`, então cada
  cliente vê a mesma reação subindo num lugar levemente diferente.
- **Efeitos sonoros.** Os botões de "Palmas", "Risada", "Uau" e "Rufar" (`ALLOWED_SOUNDS`) não
  tocam nenhum arquivo de áudio: `web/lib/sfx.ts` sintetiza cada som na hora com a Web Audio API
  (ruído filtrado para as palmas/tambor, osciladores para risada/uau). Isso evita hospedar assets
  e problemas de licenciamento. Troque por arquivos `.mp3` reais ali se preferir.
- **Avatares e identidade visual.** Todo mundo ganha um avatar [DiceBear](https://dicebear.com)
  (estilo `thumbs`, gerado por URL, sem chave nem servidor próprio) a partir de uma semente
  aleatória escolhida ao entrar. Dá pra sortear outra semente, subir uma foto do dispositivo
  (comprimida no navegador via `canvas` em `web/lib/media.ts`, sem passar por upload no servidor)
  e escolher a cor do nome. Tudo fica editável depois em **Pessoas → Seu perfil**. Os badges "Host" e
  "DJ" (quem adicionou a faixa que está tocando agora) aparecem tanto ali quanto no chat.
- **GIFs e imagens no chat.** O botão de figurinha abre uma busca que passa por
  `/api/gifs/search` no servidor, mesmo padrão de proxy do YouTube

  ```
  GIPHY_API_KEY=sua_chave    # https://developers.giphy.com
  ```

  Sem nenhuma das duas, o botão continua na UI mas mostra um aviso de que a busca não está
  configurada. O resto do chat funciona normalmente.
  
  Já o botão de imagem não depende de nenhuma chave: a foto é redimensionada e comprimida para JPEG no próprio navegador (teto de ~500 KB em base64, validado de novo no servidor em `sanitizeImageDataUrl`) e viaja embutida na mensagem. Não existe armazenamento de arquivos em disco ou S3 nesta versão. Isso é suficiente para uso casual; para uma sala com tráfego de imagem pesado, vale trocar por um meio de upload real (S3, Cloudinary etc.) e guardar só a URL.

### Build de produção

```bash
cd server && npm run build && npm start
cd web && npm run build && npm start
```

---

## 5. Indo para produção

### Estado sobrevive a reinício e a múltiplas instâncias

O `rooms.ts` não guarda mais as salas num `Map` em memória, tudo vive no Redis, serializado como
JSON sob a chave `room:<id>`. Duas consequências:

- **Reiniciar o servidor não derruba as salas.** O Redis persiste (com `appendonly` habilitado,
  que é o padrão da imagem `redis:7-alpine` usada no `docker-compose.yml`).
- **Dá para rodar mais de uma instância do servidor atrás de um load balancer.** O
  `@socket.io/redis-adapter` (ligado em `index.ts` via `io.adapter(createAdapter(pubClient, subClient))`)
  garante que um `io.to(sala).emit(...)` alcance participantes conectados em *qualquer* instância,
  não só na que recebeu o evento.

O TTL de cada sala se renova a cada ação: 6 horas enquanto tem gente dentro (salvaguarda —
na prática nunca chega perto disso, já que qualquer interação renova), 10 minutos depois que
todo mundo sai. Não existe mais o `setInterval` de limpeza manual — o próprio Redis expira a
chave.

Em produção, use um Redis gerenciado (Upstash, Redis Cloud, AWS ElastiCache) e cole a URL de
conexão TLS (`rediss://...`) em `REDIS_URL`. Para rodar localmente do jeito que roda em
produção, use o `docker-compose.yml` na raiz:

```bash
cp server/.env.example server/.env   # edite YOUTUBE_API_KEY se quiser
docker compose up --build
```

### Rate limit e filtro de chat

`chatGuard.ts` aplica uma janela deslizante por `socket.id`: mais de 5 mensagens em 3 segundos e
o servidor recusa (`room:denied`, que a UI já mostra como toast). O mesmo módulo corta mensagens maiores que 600 caracteres e barra flood de caractere repetido (`aaaaaaaaaaaa`).

Funciona como uma barreira contra abuso técnico, não moderação de conteúdo. Se a sala for aberta ao público em geral, plugue ali uma lista de termos curada para o seu público ou um serviço de moderação. Obs.: ponto de extensão é a função `sanitizeMessage()`.

Limitações: o rate limit vive em memória por processo. Com várias instâncias atrás de um load balancer, alguém mal-intencionado poderia, em teoria, reconectar e cair em outra instância para "resetar" a janela. Para fechar essa brecha, mova a contagem para o Redis (`INCR` + `EXPIRE` na chave `ratelimit:<socket.id>`) em vez do `Map` local.

### Sala com senha

Criar uma sala aceita um campo opcional de senha (a landing page já tem o toggle "Proteger com
senha"). O servidor guarda um hash `bcrypt`, nunca a senha em texto puro, e, ao entrar, compara
com `bcrypt.compare`. Se a sala tem senha e a pessoa não mandou uma (ou mandou errada), o servidor
recusa o `room:join` com o motivo (`password_required` ou `wrong_password`) em vez de deixar
entrar; o cliente mostra a tela de senha (`PasswordGate.tsx`) e tenta de novo pela mesma conexão,
sem reconectar.

Isso cobre o caso de uso de "sala privada entre amigos" sem precisar de contas de usuário, login
ou tabela de permissões.

### HTTPS e variáveis de ambiente

O código já lê tudo de variável de ambiente; o que muda em produção é só o valor:

| Variável | Onde | Valor em produção |
| --- | --- | --- |
| `CLIENT_ORIGIN` | `server/.env` | domínio do front-end, `https://...` (aceita lista separada por vírgula para staging + produção juntos) |
| `NEXT_PUBLIC_SERVER_URL` | `web/.env.local` | domínio do back-end, `https://...` |
| `REDIS_URL` | `server/.env` | URL TLS do Redis gerenciado, `rediss://...` |

O HTTPS não é opcional: o embed do YouTube só libera autoplay em iOS Safari dentro de uma página
segura, e o navegador recusa `getUserMedia`/clipboard em origem insegura (o botão "Convidar" usa
`navigator.clipboard`). Isso normalmente já vem de graça se você hospedar atrás de um provedor que
termina TLS por você (Vercel para o front-end; Render, Railway ou Fly.io para o back-end). Se for
rodar atrás do seu próprio Nginx/Caddy, o `app.set('trust proxy', 1)` em `index.ts` já está pronto
para isso — é o que faz o Express enxergar o IP e o protocolo reais do visitante, não os do proxy.

O `Dockerfile` em `server/` builda uma imagem de produção em dois estágios (compila TypeScript,
depois só copia `dist/` + dependências de produção para a imagem final).

---

## 6. Limites conhecidos e próximos passos

- **Vídeo e voz dos participantes** exigem WebRTC (mediasoup ou LiveKit); o layout já reserva o
  espaço, mas o transporte não está implementado.
- **Arquivos `.mp4`** precisam de CORS liberado na origem e de um servidor que aceite Range
  requests, senão o seek não funciona.
- **Sem recuperação de senha.** Se a sala tem senha e todo mundo esquece, a única saída é criar
  uma sala nova. Não existe conceito de "dono" fora da sessão do host atual.
- **`roomCount()` usa `KEYS room:*`**, que bloqueia o Redis por um instante proporcional ao número
  de salas. Aceitável para o health check ocasional deste projeto; troque por `SCAN` se o volume
  de salas crescer muito.
