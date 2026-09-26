# Juntos — app desktop

O mesmo app web de Watch Party, num runtime Electron. Nenhuma linha da `web/`
foi reescrita: o app carrega a rota real do Next, com o mesmo código, o mesmo
servidor de salas e o mesmo contrato de socket.

## O que muda em relação ao navegador

| | Navegador | Aqui |
|---|---|---|
| Bloqueio de iframe do YouTube | player às vezes não toca | User-Agent de Chrome puro resolve |
| Áudio do sistema na captura | impossível (`getDisplayMedia` só dá microfone) | `loopback`, com o áudio da máquina inteira |
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

## O que ainda não faz

**A tela capturada não chega aos outros participantes.** A captura local
funciona — inclusive com áudio do sistema —, mas transmitir para a sala exige
sinalização WebRTC no servidor, um `MediaKind` novo (`stream`) e o `FilePlayer`
aceitando `MediaStream` além de `src`. Nada disso existe, e o backend não foi
tocado nesta entrega. O painel diz isso na tela, em vez de fingir que transmitiu.

Para a tela chegar aos outros, o caminho é: sinalização no `server/src/socket.ts`
(o padrão de sala já tem o formato), um `stream` no contrato de `MediaItem`, e o
`FilePlayer` pegando o `MediaStream` do painel em vez de um `src`.

## Notas de plataforma

Só Windows, por causa do áudio de sistema: `loopback` não existe nos outros
sistemas, e o Electron é explícito a respeito. Um `.dmg` aqui seria uma
promessa que o app não cumpre.

Sem certificado de assinatura, o Windows SmartScreen avisa na primeira execução.
O instalador funciona normalmente.
