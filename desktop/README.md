# Juntos — app desktop

O mesmo app web de Watch Party, num runtime Electron. Nenhuma linha da `web/`
foi reescrita: o app carrega a rota real do Next, com o mesmo código, o mesmo
servidor de salas e o mesmo contrato de socket.

## O que muda em relação ao navegador

| | Navegador | Aqui |
|---|---|---|
| Bloqueio de iframe do YouTube | player às vezes não toca | User-Agent de Chrome puro resolve |
| Áudio do sistema na captura | impossível (`getDisplayMedia` só dá microfone) | `loopback`, com o áudio da máquina inteira |
| Transmitir tela para a sala | o navegador entrega o fluxo só para a própria aba | WebRTC um-para-muitos |
| Autoplay do vídeo da fila | bloqueado sem gesto | liberado |
| Origem | a da hospedagem | `http://localhost:3210`, fixa |

O motivo de o servidor de salas continuar intocado é que ele é multiusuário: a
sincronização entre pessoas é dele. O Electron cuida só da janela.

## Antes de rodar: uma mudança obrigatória no servidor

A janela carrega de `http://localhost:3210`, então **essa origem precisa estar
no `CLIENT_ORIGIN` do servidor de salas**. Sem isso o app abre e mostra
"O servidor não respondeu".

No Render, em *Environment*:

```
CLIENT_ORIGIN=https://juntoswatchparty.vercel.app,http://localhost:3210
```

E o mesmo para o `server/.env` no desenvolvimento local.

## Gerar o instalador

```powershell
cd desktop
npm install
$env:NEXT_PUBLIC_SERVER_URL="https://juntos-watchparty.onrender.com"
npm run dist
```

O instalador sai em `desktop/release/Juntos Setup <versão>.exe`.

`NEXT_PUBLIC_SERVER_URL` é embutida no bundle em build — não dá para ajustar
depois. Sem ela, o app assume `http://localhost:4000` e não acha o servidor.

Para desenvolver sem empacotar: `npm start`.

## Como é montado

```
desktop/electron/
  main/
    index.ts        janela, permissões, user-agent, ciclo de vida
    localServer.ts  sobe e vigia o servidor Next local
    capture.ts      desktopCapturer + áudio do sistema
    log.ts          log em arquivo
  preload/
    index.ts        a única ponte entre os processos
  shared/
    contract.ts     o formato da API, que os dois lados conhecem
```

O web entra no app por `output: 'standalone'`: o Next gera um servidor
autocontido que o processo principal sobe numa porta fixa. Isso existe para
**não mexer na `web/`** — o `getServerSideProps` de `/room/[id]` continua
funcionando, e `/room/abc` abre igual no app e no site.

O `output: 'standalone'` só liga quando `NEXT_STANDALONE=1` está no ambiente,
então o build da Vercel não muda.

### Decisões que não são óbvias

**Porta fixa (3210).** O Render não aceita coringa em `CLIENT_ORIGIN`, só lista.
Com porta aleatória seria impossível declarar a origem de lá.

**`HOSTNAME=127.0.0.1`.** O servidor interno não tem por que responder na rede
local; ouvir em todas as interfaces abriria o servidor de salas para qualquer
pessoa na mesma rede Wi-Fi.

**`contextIsolation` e `sandbox` ligados, `nodeIntegration` desligado.** O
renderer não tem Node. Tudo que ele faz da máquina passa por uma lista
explícita de canais no `preload`, e cada argumento é validado antes de cruzar —
inclusive o id da tela escolhida, que o processo principal confere contra a
lista que ele mesmo enumerou.

**Log em arquivo.** Quem abre o app não tem console. Fica em
`%APPDATA%\Juntos\logs\`, um arquivo por dia. É o primeiro lugar a olhar quando
o app não abre.

## Transmissão de tela

A tela capturada **chega aos outros participantes** por WebRTC. O servidor não
transporta mídia: ele entrega só as mensagens de negociação (offer, answer,
candidate) entre as duas pessoas, e depois disso elas se falam direto. A
mídia não passa pelo Redis nem custa banda do servidor.

Uma pessoa transmite por vez, e quem transmite cria uma `RTCPeerConnection` por
espectador — todas alimentadas pelo mesmo `MediaStream`, então a captura é única
mesmo com dez pessoas assistindo.

### O limite honesto

**Não há servidor TURN.** A conexão só sai entre duas pessoas que se alcançam
por rede local ou por STUN direto. Duas pessoas em redes diferentes — uma atrás
de NAT corporativo, outra em 4G — podem não se ver. Isso não é um bug de
implementação: relay exige um servidor de mídia, que o projeto não tem, e é
infraestrutura, não código.

O palco não gira em falso: quando a conexão falha, a tela mostra o motivo.

### Como a autorização funciona no servidor

- `stream:publish` — registra a transmissão e põe a faixa `stream` tocando
- `stream:subscribe` / `stream:unsubscribe` — o espectador pede e larga
- `stream:signal` — o relay cego, com teto de 64 KB por mensagem
- `stream:peer-join` / `stream:peer-leave` — para o dono criar e fechar uma
  conexão por espectador
- `stream:stopped` — chega a todos, inclusive quando o dono fecha a janela

Quem transmite é identificado pelo `userId`, não pelo socket: a conexão pode
cair e voltar, e a transmissão continua sendo a mesma.

## Notas de plataforma

Só Windows, por causa do áudio de sistema: `loopback` não existe nos outros
sistemas, e o Electron é explícito a respeito. Um `.dmg` aqui seria uma
promessa que o app não cumpre.

Sem certificado de assinatura, o Windows SmartScreen avisa na primeira execução.
O instalador funciona normalmente.
