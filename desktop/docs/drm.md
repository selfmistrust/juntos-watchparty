# DRM do Prime Video: o que foi medido, e o que dá para fazer

Este documento é o resultado da investigação do erro "Vídeo indisponível" ao
tocar um título. Ele não promete reprodução: registra o que foi medido, e o
custo de cada caminho.

## O veredito

Rodando o mesmo experimento que a sonda do app usa, com o Chromium que o
instalador empacota:

```
electron 33.4.11   chromium 130.0.6723.191
requestMediaKeySystemAccess existe .... sim
contexto seguro .................... sim      (precondição verificada)
navigator.plugins .................. PDF Viewer, Chrome PDF Viewer,
                                      Chromium PDF Viewer, Microsoft Edge PDF
                                      Viewer, WebKit built-in PDF
cenc: NotSupportedError
vazia: NotSupportedError
```

`NotSupportedError` é a assinatura de **nenhum CDM registrado no build**. E a
resposta é válida porque a precondição está verificada na mesma execução: a
página rodou em contexto seguro.

Isso descarta os outros dois casos sem ambiguidade:

| caso | estado | por que não é este caso |
|---|---|---|
| **A** | Widevine indisponível | **é este.** A EME responde `NotSupportedError` antes de qualquer pergunta de permissão |
| **B** | permissão `mediaKeySystem` bloqueada | não é. Não existe CDM para pedir permissão de decifrar |
| **C** | DRM ok, Prime recusa o ambiente | não é. Não existe cliente certificado para ser recusado |

O permissor que o app instala está correto e foi verificado — ele concede
`mediaKeySystem` para `primevideo.com`, para as lojas regionais da Amazon e para a
origem local da sonda, e **recusa** `notamazon.com`, `amazon.com.br.evil.net` e
`evilprimevideo.com`. Ele nunca chegou a ser consultado, porque a falha é antes.

## A causa raiz

**O Electron não embarca o CDM do Widevine, por motivo de licença.** Não é bug
de configuração, não é permissão, e não é o build estar quebrado. O Widevine é
componente proprietário da Google, com licenciamento próprio, e o Electron é
construído para não depender de fonte fechada além do sistema operacional.

A consequência é simétrica e vale estar explícito: **o Electron oficial não
toca vídeo protegido, e isso não vai mudar por configuração.** Quem resolve isso
é uma distribuição que traga o CDM e a licença junto.

### O teste de controle ainda falta

Falta uma coisa, e é sua: abrir **o mesmo título** no Chrome ou no Edge, na mesma
conta. Se tocar lá e não aqui, o problema está confirmado como sendo do ambiente
Electron — e não do título, nem da conta, nem da sua rede. Sem esse teste, a
medição acima diz que *não temos CDM*, o que já é o bastante para decidir, mas
não fecha a regra de que a conta e o título estão bons.

## Opção 1 — Reproduzir dentro do Juntos, no Electron oficial

**Não é possível.** Não é escolha de configuração: o componente não existe no
build. Qualquer caminho que "fizesse funcionar" exigiria copiar o
`widevinecdm.dll` do Chrome para dentro do app — que é violar licença, é
proibido aqui, e é a razão de o Electron não trazer o componente.

## Opção 2 — Runtime com DRM (Electron for Content Security, da Castlabs)

A distribuição que existe para isso. É um fork do Electron, com o mesmo código, e
troca-se a dependência.

Os oito pontos:

**1. Mudança de runtime.** Trocar `electron` por
`github.com/castlabs/electron-releases` no `devDependencies`, e esperar
`components.whenReady()` antes de abrir a primeira janela — a instalação do CDM é
assíncrona e acontece no primeiro lançamento. Sem essa espera, a primeira
reprodução falha por uma razão que parece outra.

**2. Windows e macOS.** Ambos suportados. Linux é parcial: o CDM do Widevine não
faz VMP ali, então não há assinatura a fazer nem licenças persistentes.

**3. Assinatura para produção.** Este é o ponto caro. Os binários públicos vêm
assinados **para desenvolvimento**, e isso só funciona contra servidores de
licença de teste (UAT). Para produção é preciso assinar via **EVS**, o serviço
gratuito da Castlabs, que exige criar conta. E há uma pegadinha operacional
importante: **no Windows a assinatura quebra se algo alterar o executável
depois** — trocar o ícone, code-signing. A assinatura VMP tem de ser a última
etapa do empacotamento, via hook `afterSign` do `electron-builder`, nunca
`afterPack`.

**4. Impacto no `electron-builder`.** O `electron-builder` baixa o Electron
padrão. Para ele empacotar a Castlabs é preciso apontar o espelho:
`electronDownload.mirror` para `https://github.com/castlabs/electron-releases/releases/download/v`.
Sem isso, o `npm run dist` empacota o Electron oficial e você recebe um
instalador sem DRM — que é exatamente o modo de falha mais confuso possível.

**5. Atualizações automáticas.** O `electron-builder` cuida do app. O **CDM tem
atualização própria**, disparada pelo app na primeira execução de cada
lançamento. O download acontece em segundo plano, com atraso, e pode ser
desligado com `--disable-component-update`. Isso significa que uma atualização do
Electron pode chegar com o app antes do CDM estar instalado — e a diferença de
comportamento entre a primeira execução depois de uma atualização do Electron e
uma execução já aquecida é mais uma coisa que o diagnóstico vai encontrar.

**6. Licenciamento.** O ECS é gratuito para download e uso. A **assinatura**
(VMP) é gratuita via EVS, mas exige cadastro. Uma ressalva honesta: isso é
licença de *assinatura de Widevine para o seu app*, e ela pressupõe que você
cumpra os termos do Widevine — a Castlabs faz a auditoria de conformidade quando
você pede certificado de produção. O caminho de 3PL (certificação comercial) é
outro contrato.

**7. Segurança.** O ponto positivo é real: VMP existe justamente para impedir
que o conteúdo decifrado seja capturado fora de um caminho confiável, e o build
assinado o garante. O ponto de atenção é o download do CDM na primeira execução:
é um componente binário baixado e executado no arranque. Convém confirmar a
assinatura do pacote antes de confiar nele, e ter em mente que a instalação
ocorre por um servidor de componentes.

**8. Se o Prime Video realmente funciona.** **Não garantido, e há evidência de que
não seja garantido.** O Netflix, por exemplo, é o caso documentado que exige
assinatura de produção *e* funciona depois dela. Para o Prime Video não há
declaração pública. Sabe-se que serviços de DRM variam: alguns aplicam VMP
obrigatório, outros aplicam verificações adicionais como User-Agent, e alguns
recusam clientes não certificados. Vale notar que o app hoje remove o
override de User-Agent justamente porque o UA do Electron não confere com o
motor — e alguns serviços usam o UA como sinal. **Esta é a questão que só se
responde testando**, e é a razão de esta opção não ser uma decisão de
configuração e sim um projeto.

## Opção 3 — Fallback para o navegador oficial

O caminho que a integração já assume quando o build não toca. E o que ela já faz
desde o começo: o botão "Abrir no Prime Video" abre o título no navegador da pessoa, na
conta dela, onde funciona.

O que falta estava feito nesta etapa: o botão aparecia **só** quando havia um
item na fila tocando. No modo navegação — o Prime aberto pelo card, com o título
escolhido à mão, que é exatamente quando alguém encontra o erro de DRM — o botão
não existia. Era a pessoa com uma tela de erro e nenhum caminho de saída.

## Recomendação

**Opção 3**, e ela não é uma derrota: é o que o app já prometia. A Prime Video
entrega o vídeo direto para o aparelho de cada pessoa, na conta dela, e o
servidor do Juntos não participa. O app funciona como sala de cinema, com a
contagem de prontos, e o Prime é o que reproduz.

A opção 2 é o único caminho para reprodução dentro do app, e ela é um projeto —
troca de runtime, assinatura VMP de produção, hook de empacotamento, espelho de
download, e uma resposta desconhecida sobre se o Prime aceita o cliente. Faz
sentido encarar isso se reprodução dentro do app virar requisito de produto — e
não antes. Se for esse o caso, o primeiro passo não é migrar: é abrir uma
conta na EVS e assinar um build de teste, e ver se o Prime toca. Isso custa uma
hora e responde à única pergunta que realmente importa.

## O que não foi feito, e por quê

- Nenhum `widevinecdm.dll` copiado do Chrome.
- Nenhuma chave extraída, nenhum manifesto alterado, nenhuma requisição de
  licença interceptada, nenhum DRM desativado.
- Nenhum `--no-sandbox` como contorno.
- Nenhuma resposta do player falsificada.
- Nenhuma retransmissão pelo Juntos.
- Nenhuma tentativa de extrair o stream.

O diagnóstico usou `console-message` filtrado e o log de permissões. O
`webContents.debugger` ficou de fora **de propósito**: ele veria o corpo da
requisição de licença, e esse corpo é a mensagem de solicitação de licença.