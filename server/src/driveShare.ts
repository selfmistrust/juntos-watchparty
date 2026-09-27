import { redis } from './redis.js';
import { getValidAccessToken } from './driveOAuth.js';
import { donoDoTrack } from './driveTrack.js';

/**
 * Compartilhamento do vídeo escolhido com quem está na sala.
 *
 * ## O que o Render faz, e o que ele não faz
 *
 * Ele decide **quem** pode ver o arquivo e manda o Google criar a permissão. Não
 *movimenta byte de vídeo: cada pessoa baixa direto do Google, com o token da
 * própria conta, e o Render só carrega `fileId`, play, pause, seek e o estado
 * da sala. R2 não participa de nada disso.
 *
 * ## Só revogamos o que criamos
 *
 * Cada `permissionId` que o Juntos cria fica guardado em `concessoes`. Na
 * revogação, apagamos **exatamente esses ids**. Um compartilhamento que a
 * pessoa já tinha antes — um colega de trabalho, o parceiro, quem quer que fosse
 * — nunca entra na lista e nunca é tocado. É a diferença entre "temporário" e
 * "temporário para quem a gente colocou".
 *
 * ## Por que listar antes de criar
 *
 * `permissions.list` roda com `drive.file` e é o que permite distinguir os dois
 * casos: se a pessoa já tem permissão no arquivo, não criamos outra nem
 * registramos nada — e portanto não vamos revogar depois. Sem essa checagem,
 * tirar a faixa da fila poderia tirar o acesso de alguém que já tinha.
 *
 * ## Um aviso honesto sobre a memória do Google
 *
 * A permissão no Drive é reversível aqui. O *grant* do app sobre o arquivo, esse
 * não é: ele pertence à conta de quem autorizou e só some se a pessoa
 * desautorizar o juntos por completo. Sair da sala desfaz o compartilhamento,
 * não o vínculo. Está registrado na política de privacidade.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3';
const FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/** Concede o mesmo prazo máximo de vida da sala, para não vazar registro. */
const SHARE_TTL_SEC = 24 * 60 * 60;

const shareKey = (roomId: string) => `drive:share:${roomId}`;

/**
 * Em quais salas esta conta concedeu acesso.
 *
 * Sem isto, desconectar o Drive não teria como saber o que revogar: o
 * registro de compartilhamento é por sala, e a rota de desconexão não sabe em
 * qual sala a pessoa está. Guardar a lista na própria sessão resolve, e é o que
 * permite derrubar tudo numa única chamada.
 */
const salasDaConcessao = (sessionId: string) => `drive:shareowner:${sessionId}`;

/** Uma permissão que o Juntos criou. Só estas saem na revogação. */
type Concessao = { permissionId: string; email: string; userId: string };

type ShareRecord = { fileId: string; concessoes: Concessao[] };

/**
 * Uma pessoa da sala, do ponto de vista do Drive: só importa o identificador
 * estável e o e-mail da conta conectada.
 */
export type ParticipanteDrive = { userId: string; email: string | null };

async function lerShare(roomId: string): Promise<ShareRecord | null> {
  const raw = await redis.get(shareKey(roomId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ShareRecord;
    if (!parsed.fileId || !Array.isArray(parsed.concessoes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function gravarShare(roomId: string, record: ShareRecord | null): Promise<void> {
  if (!record) {
    await redis.del(shareKey(roomId));
    return;
  }
  await redis.set(shareKey(roomId), JSON.stringify(record), 'EX', SHARE_TTL_SEC);
}

function accessTokenDoDono(ownerSessionId: string): Promise<string | null> {
  return getValidAccessToken(ownerSessionId).then((r) => (r.ok ? r.accessToken : null));
}

/** Quem já tem permissão no arquivo, segundo o Google. */
async function permissiveExistentes(accessToken: string, fileId: string): Promise<Set<string>> {
  const url = new URL(`${DRIVE}/files/${fileId}/permissions`);
  url.searchParams.set('fields', 'permissions(id,emailAddress,type)');
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('supportsAllDrives', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return new Set();
    const data = (await response.json()) as { permissions?: { emailAddress?: string; type?: string }[] };
    return new Set(
      (data.permissions ?? [])
        .map((p) => p.emailAddress?.toLowerCase())
        .filter((e): e is string => Boolean(e)),
    );
  } catch {
    clearTimeout(timeout);
    return new Set();
  }
}

async function criarReader(
  accessToken: string,
  fileId: string,
  email: string,
): Promise<string | null> {
  const url = new URL(`${DRIVE}/files/${fileId}/permissions`);
  url.searchParams.set('supportsAllDrives', 'true');
  // Sem o e-mail de notificação: quem entrou na sala não precisa receber um
  // "X compartilhou um arquivo com você" do Google, e o convite é do juntos.
  url.searchParams.set('sendNotificationEmail', 'false');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function apagarReader(accessToken: string, fileId: string, permissionId: string): Promise<void> {
  const url = new URL(`${DRIVE}/files/${fileId}/permissions/${encodeURIComponent(permissionId)}`);
  url.searchParams.set('supportsAllDrives', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
  } catch {
    // Revogar é cortesia aqui: a permissão tem prazo do lado do Google e a
    // pessoa pode remover na mão pelo painel do Drive. Silenciar é preferível a
    // derrubar a sala.
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Deixa a sala como está: o arquivo ativo é `fileId`, e estas pessoas precisam
 * de acesso.
 *
 * Chamado depois de qualquer coisa que mude o panorama — entrada, saída, troca
 * de faixa — e **fora** do lock da sala, porque cada passo é uma ida ao Google
 * e segurar a fila por isso faria a sala esperar pela rede.
 */
export async function reconciliarCompartilhamento(params: {
  roomId: string;
  fileId: string | null;
  participantes: ParticipanteDrive[];
}): Promise<void> {
  const { roomId, fileId, participantes } = params;
  const atual = await lerShare(roomId);

  /*
   * A faixa trocou. As permissões do arquivo anterior saem inteiras — são
   * todas do Juntos, por construção — e o registro é zerado antes de qualquer
   * concessão nova, para que uma falha no meio não deixe o arquivo velho
   * compartilhado e o novo pela metade.
   */
  if (!fileId) {
    if (atual) await revogarTudo(roomId);
    return;
  }
  if (atual && atual.fileId !== fileId) {
    await revogarTudo(roomId);
  }

  // O dono vem do registro do `fileId`, nunca do chamador: quem concede tem que
  // ser quem concessionou o acesso original. Passar o dono adiante faria de
  // qualquer rota nova uma maneira de compartilhar o arquivo de outra pessoa.
  const ownerSessionId = await donoDoTrack(fileId);
  if (!ownerSessionId) return;
  const accessToken = await accessTokenDoDono(ownerSessionId);
  if (!accessToken) return;

  const registro = (await lerShare(roomId)) ?? { fileId, concessoes: [] };
  const jaConcedidos = new Set(registro.concessoes.map((c) => c.email.toLowerCase()));
  const faltando = participantes.filter(
    (p) => p.email && EMAIL.test(p.email) && !jaConcedidos.has(p.email.toLowerCase()),
  );
  if (faltando.length === 0) {
    // Mesmo sem concessão nova, o arquivo ativo fica registrado: sem isso a
    // próxima rodada gastaria uma chamada a mais ao Google para descobrir que
    // já está tudo certo.
    if (!atual || atual.fileId !== fileId) await gravarShare(roomId, { fileId, concessoes: [] });
    return;
  }

  const existentes = await permissiveExistentes(accessToken, fileId);
  const novas: Concessao[] = [];
  for (const pessoa of faltando) {
    const email = pessoa.email as string;
    // Já tinha acesso por conta própria: não criamos e não registramos, então
    // nunca vamos revogar o que era de outra pessoa.
    if (existentes.has(email.toLowerCase())) continue;
    const permissionId = await criarReader(accessToken, fileId, email);
    if (permissionId) novas.push({ permissionId, email, userId: pessoa.userId });
  }

  await gravarShare(roomId, { fileId, concessoes: [...registro.concessoes, ...novas] });
  if (novas.length > 0) await lembrarSalaDaConcessao(ownerSessionId, roomId);
}

async function lembrarSalaDaConcessao(sessionId: string, roomId: string): Promise<void> {
  const raw = await redis.get(salasDaConcessao(sessionId));
  let salas: string[] = [];
  if (raw) {
    try {
      salas = JSON.parse(raw) as string[];
    } catch {
      salas = [];
    }
  }
  if (salas.includes(roomId)) return;
  await redis.set(salasDaConcessao(sessionId), JSON.stringify([...salas, roomId]), 'EX', SHARE_TTL_SEC);
}

/**
 * Derruba tudo que a conta estava sustentando, em todas as salas.
 *
 * É o caminho do "desconectar" e do "encerrar a sessão": quem escolheu o
 * arquivo sai, e as pessoas que o Juntos colocou nele perdem o acesso. Sem
 * revogação aqui elas continuariam listadas no painel de compartilhamento do
 * Drive de quem escolheu, sem ninguém assistindo.
 */
export async function revogarTudoDaSessao(sessionId: string): Promise<void> {
  const raw = await redis.get(salasDaConcessao(sessionId));
  await redis.del(salasDaConcessao(sessionId));
  if (!raw) return;
  let salas: string[] = [];
  try {
    salas = JSON.parse(raw) as string[];
  } catch {
    return;
  }
  for (const roomId of salas) await revogarTudo(roomId);
}

/**
 * Tira tudo o que o Juntos criou nesta sala, e nada mais.
 *
 * É o caminho de saída da sala, de troca de mídia e de fim de sessão. O
 * registro local some junto, para que uma revogação parcial não vire tentativa
 * infinita: quem não conseguiu revogar por erro de rede não será revogado
 * depois, e isso está na política de privacidade.
 */
export async function revogarTudo(roomId: string): Promise<void> {
  const registro = await lerShare(roomId);
  await gravarShare(roomId, null);
  if (!registro || registro.concessoes.length === 0) return;
  const ownerSessionId = await donoDoTrack(registro.fileId);
  if (!ownerSessionId) return;
  const accessToken = await accessTokenDoDono(ownerSessionId);
  if (!accessToken) return;
  for (const concessao of registro.concessoes) {
    await apagarReader(accessToken, registro.fileId, concessao.permissionId);
  }
}

/** Tira a concessão de quem saiu, se ele tinha uma que criamos. */
export async function revogarParaUsuario(roomId: string, userId: string): Promise<void> {
  const registro = await lerShare(roomId);
  if (!registro) return;
  const alvo = registro.concessoes.filter((c) => c.userId === userId);
  if (alvo.length === 0) return;
  await gravarShare(roomId, {
    fileId: registro.fileId,
    concessoes: registro.concessoes.filter((c) => c.userId !== userId),
  });
  const ownerSessionId = await donoDoTrack(registro.fileId);
  if (!ownerSessionId) return;
  const accessToken = await accessTokenDoDono(ownerSessionId);
  if (!accessToken) return;
  for (const concessao of alvo) {
    await apagarReader(accessToken, registro.fileId, concessao.permissionId);
  }
}

/** Só para o servidor: o registro vivo, para testes e diagnóstico. */
export async function concessoesVivas(roomId: string): Promise<ShareRecord | null> {
  return lerShare(roomId);
}
