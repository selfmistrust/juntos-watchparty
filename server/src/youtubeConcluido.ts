/**
 * Tela de conclusão do login do YouTube.
 *
 * ## Por que existe
 *
 * O Google recusa autenticar dentro da janela do Electron — "esse navegador ou
 * app pode não ser seguro". Então, no app desktop, a autorização acontece no
 * navegador do sistema, e é o navegador que recebe o callback.
 *
 * Sem esta tela, o callback redirecionava o navegador para `http://localhost:3210`,
 * que é o app: aparecia uma segunda cópia do Juntos no navegador, e a janela do
 * desktop continuava sem conta nenhuma até a pessoa clicar nela. Este HTML
 * substitui essa cópia por uma frase e um botão, e a janela do desktop se
 * atualiza sozinha quando recebe o foco.
 *
 * ## Por que é do servidor, e não uma página do app
 *
 * O callback chega no servidor, então é o lugar natural para a resposta — e
 * assim a tela não depende de o app estar rodando nem de entrar no bundle do
 * Next. Um app desktop e um navegador recebem a mesma página.
 *
 * ## O que ela deliberadamente não faz
 *
 * Não redireciona sozinha, não mostra o nome da conta e não carrega nada de
 * terceiro. Quem chegou aqui tem uma aba do navegador com uma frase; fechar a
 * aba é seguro e a janela do desktop já sabe de tudo.
 */

const ESTADOS = {
  connected: {
    titulo: 'Conta conectada',
    corpo: 'A conta do YouTube foi vinculada à sua conta do Juntos. Volte para o app: ele já está atualizando.',
    ok: true,
  },
  denied: {
    titulo: 'Autorização recusada',
    corpo: 'Você cancelou na tela do Google. Nada foi alterado — pode tentar de novo pelo app.',
    ok: false,
  },
  error: {
    titulo: 'Não foi possível conectar',
    corpo:
      'O servidor recusou a autorização. O mais comum é o link ter sido usado duas vezes, ' +
      'o que o Google não permite. Tente de novo pelo app.',
    ok: false,
  },
  not_configured: {
    titulo: 'Integração não configurada',
    corpo: 'O servidor não tem as credenciais do YouTube. Isso é configuração do servidor, não da sua conta.',
    ok: false,
  },
} as const;

export type YoutubeConcluidoEstado = keyof typeof ESTADOS;

/** Escapa o que vier na query antes de colocar dentro do HTML. */
function esc(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function paginaConcluido(estadoBruto: string | undefined): {
  status: number;
  html: string;
} {
  const chave = (estadoBruto ?? '') in ESTADOS ? (estadoBruto as YoutubeConcluidoEstado) : 'error';
  const info = ESTADOS[chave];
  // Um estado desconhecido é erro do servidor ou link adulterado. 200 deixaria
  // o navegador achar que deu certo; 400 diz que o pedido foi ruim.
  const status = chave === 'error' && estadoBruto !== 'error' ? 400 : 200;

  const titulo = esc(info.titulo);
  const corpo = esc(info.corpo);
  const cor = info.ok ? '#A78BFA' : '#FCA5A5';

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${titulo} — Juntos</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem; background: #08080A; color: #EDEDEF;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 30rem; text-align: center; }
  .marca { font-size: 1.125rem; letter-spacing: -0.01em; margin: 0 0 2.5rem; }
  .selo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 3.5rem; height: 3.5rem; border-radius: 1rem;
    background: rgba(255,255,255,.05); margin: 0 0 1.5rem;
  }
  .selo::after { content: ""; width: 1.375rem; height: 1.375rem; background: ${cor}; }
  .selo.ok::after {
    clip-path: polygon(14% 44%, 0 60%, 40% 100%, 100% 22%, 84% 6%, 39% 66%);
  }
  .selo.nao::after { background: none; box-shadow: inset 0 0 0 3px ${cor}; border-radius: 50%; }
  h1 { font-size: 1.375rem; font-weight: 500; margin: 0 0 .75rem; }
  p { font-size: .875rem; line-height: 1.6; color: #9C9CA6; margin: 0; }
  .dica { margin-top: 2rem; font-size: .75rem; color: #6C6C78; }
</style>
</head>
<body>
  <main>
    <p class="marca">juntos</p>
    <div class="selo ${info.ok ? 'ok' : 'nao'}" aria-hidden="true"></div>
    <h1>${titulo}</h1>
    <p>${corpo}</p>
    <p class="dica">Esta aba pode ser fechada.</p>
  </main>
</body>
</html>`;

  return { status, html };
}
