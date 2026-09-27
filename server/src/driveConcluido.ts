/** A aba do navegador recebe só uma confirmação; a seleção é entregue à sessão do app. */
const ESTADOS = {
  connected: {
    titulo: 'Google Drive conectado',
    corpo: 'Volte para o Juntos para escolher um vídeo do seu Drive.',
  },
  picked: {
    titulo: 'Vídeo selecionado',
    corpo: 'Volte para o Juntos. O app continuará copiando o vídeo para a sala e mostrará o progresso.',
  },
  cancelled: {
    titulo: 'Seleção cancelada',
    corpo: 'Volte para o Juntos para escolher outro vídeo quando quiser.',
  },
  denied: {
    titulo: 'Autorização recusada',
    corpo: 'Você cancelou a autorização do Google Drive. Pode tentar novamente pelo Juntos.',
  },
  expired: {
    titulo: 'Seleção encerrada',
    corpo: 'Este pedido expirou, foi cancelado ou já foi usado. Abra uma nova seleção pelo Juntos.',
  },
  error: {
    titulo: 'Não foi possível concluir',
    corpo: 'A seleção do Google Drive não foi concluída. Volte para o Juntos e tente novamente.',
  },
  not_configured: {
    titulo: 'Google Drive não configurado',
    corpo: 'A integração com o Google Drive ainda precisa ser configurada no servidor do Juntos.',
  },
} as const;

export function paginaDriveConcluido(estado: string | undefined): { status: number; html: string } {
  // Só textos fixos entram no HTML, inclusive para queries desconhecidas.
  const valido = typeof estado === 'string' && Object.hasOwn(ESTADOS, estado);
  const info = ESTADOS[valido ? estado as keyof typeof ESTADOS : 'error'];
  return {
    status: valido ? 200 : 400,
    html: `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${info.titulo} — Juntos</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem;
      background: #08080A; color: #EDEDEF; font-family: ui-sans-serif, system-ui, sans-serif; }
    main { max-width: 30rem; text-align: center; }
    .marca { color: #A78BFA; font-size: 1.125rem; margin-bottom: 2rem; }
    h1 { font-size: 1.375rem; font-weight: 500; }
    p { color: #9C9CA6; font-size: .875rem; line-height: 1.6; }
    .dica { margin-top: 2rem; font-size: .75rem; color: #6C6C78; }
  </style>
</head>
<body>
  <main>
    <p class="marca">juntos</p>
    <h1>${info.titulo}</h1>
    <p>${info.corpo}</p>
    <p class="dica">Esta aba pode ser fechada.</p>
  </main>
</body>
</html>`,
  };
}
