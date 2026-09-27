'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { isDesktop } from '@/lib/desktop';
import {
  disconnectDrive,
  driveConnectUrl,
  driveStartUrl,
  fetchDriveStatus,
  type DriveAccountStatus,
} from '@/lib/driveAccount';

const idle: DriveAccountStatus = { configured: false, connected: false };

type DriveAccountValue = {
  status: DriveAccountStatus;
  loading: boolean;
  busy: boolean;
  message: string | null;
  error: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const DriveAccountContext = createContext<DriveAccountValue | null>(null);

/*
 * Vigia do login que não voltou.
 *
 * ## O buraco que isso fecha
 *
 * O OAuth do Drive é a única parte do fluxo em que a nossa página **sai** e
 * alguém mais decide se volta. Se o Google morre na tela de escolha de conta, o
 * callback nunca chega, e o app fica parado com o botão de conectar, sem nunca
 * dizer nada. Do lado de quem está olhando, "o botão não funciona" e "o Google
 * recusou" são indistinguíveis — e essa era a situação reportada: duas pessoas
 * vendo `unknownerror_view` no Google e nenhuma pista de onde o fluxo parou.
 *
 * O que dá para provar é o suficiente, e é o que importa: nós emitimos o
 * `/start` no instante X, o servidor respondeu, o callback não voltou, e a conta
 * continua desconectada. Isso é um motivo verificável. **Por que** o Google não
 * voltou fica fora do nosso alcance — a tela é do Google e a falha acontece
 * antes de qualquer chamada ao nosso servidor — então a mensagem diz o que
 * sabemos e aponta a checagem, em vez de inventar uma causa.
 *
 * ## Por que `sessionStorage` e não um `useState`
 *
 * A página é descarregada no meio do fluxo: o `connect` chama
 * `location.assign` e o documento morre. Um `useState` se perde junto, e com ele
 * a prova de que o login tinha partido. `sessionStorage` é por aba e sobrevive à
 * navegação, então a volta ao app ainda encontra o carimbo. `localStorage`
 * sobreviveria também, mas por aba é o certo: o vigia precisa ser do login que
 * saiu daqui, não de um que começou numa aba anterior.
 *
 * ## Por que 90 segundos
 *
 * O Google mostra a tela de conta rápido, mas ler o consentimento leva tempo. 90
 * s é folgado o bastante para não acusar uma pessoa que está lendo os escopos, e
 * curto o bastante para não virar espera. Passado o prazo, a mensagem é mostrada
 * uma vez e o carimbo é limpo — a partir daí ela vira estado normal, senão um
 * login abandonado de horas atrás continuaria acusando.
 */
const CHAVE_ESPERA = 'juntos.drive.loginIniciadoEm';
const ESPERA_MS = 90_000;

function marcarEspera(): void {
  try {
    window.sessionStorage.setItem(CHAVE_ESPERA, String(Date.now()));
  } catch {
    /*
     * Modo privado ou `sessionStorage` bloqueado. Perder a marca aqui só custa o
     * vigia, e falhar o login por causa disso seria pior que não tê-lo.
     */
  }
}

function lerEspera(): number | null {
  try {
    const bruto = window.sessionStorage.getItem(CHAVE_ESPERA);
    if (!bruto) return null;
    const quando = Number(bruto);
    return Number.isFinite(quando) ? quando : null;
  } catch {
    return null;
  }
}

function limparEspera(): void {
  try {
    window.sessionStorage.removeItem(CHAVE_ESPERA);
  } catch {
    /* mesma razão de `marcarEspera`: sem storage não há vigia, e tudo o mais segue */
  }
}

const LOGIN_NAO_VOLTOU =
  'O Google não voltou do login. A tela de escolha de conta não completou, então a conta segue desconectada. Costuma ser o navegador bloqueando o seletor de contas do Google: tente em uma janela anônima, ou em outro navegador, antes de tentar de novo.';

/** As mesmas quatro mensagens do YouTube, adaptadas ao que a pessoa fez. */
const MENSAGENS: Record<string, string> = {
  connected: 'Conta do Drive conectada.',
  denied: 'A autorização do Google Drive foi recusada.',
  not_configured: 'A conexão com o Google Drive ainda não está configurada no servidor.',
  error: 'Não foi possível conectar o Google Drive. Tente de novo.',
};

function mensagemDe(estado: string | string[] | undefined): string | null {
  const valor = Array.isArray(estado) ? estado[0] : estado;
  if (!valor) return null;
  return MENSAGENS[valor] ?? null;
}

/**
 * Estado da conta do Google Drive.
 *
 * ## Onde o login acontece, e por quê
 *
 * No app desktop a autorização sai para o navegador do sistema, porque o Google
 * recusa autenticar dentro da janela do Electron. E o `/start` não pode ser
 * buscado pelo navegador: ele não tem o cookie de sessão do app, e o servidor
 * forjaria uma sessão nova — a conta ficaria ligada a ela, e o app continuaria
 * sem conta nenhuma depois de ter autorizado tudo.
 *
 * Por isso o desktop pede a URL em `POST` (que leva o cookie) e entrega só a
 * URL do Google ao navegador. O registro nasce com a sessão do app, que é quem
 * pergunta pelo estado depois.
 *
 * ## A reconsulta no foco
 *
 * A janela do desktop só descobre que a conta conectou quando recebe o foco de
 * novo, e é aí que este `refresh` roda. Sem ele, o app ficaria mostrando "sem
 * conta" até recarregar — e ninguém recarrega, porque para a pessoa o fluxo já
 * acabou.
 */
export function DriveAccountProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<DriveAccountStatus>(idle);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * `message` é um **evento** — "acabei de conectar" — e `status.connected` é
   * um **estado**. Misturar os dois produz a tela da captura: a linha de status
   * dizia "Nenhuma conta conectada" e, logo abaixo, "Conta do Drive conectada",
   * porque a mensagem do OAuth continuava na tela depois que o estado já era o
   * oposto.
   *
   * A divergência tem um caminho silencioso: `refresh` roda a cada foco de
   * janela, e ele atualiza o estado sem tocar na mensagem. Quem saía do OAuth
   * vê a confirmação — e, se depois algo desconectasse a conta por outro caminho
   * (a aba do Google, o `token_unavailable` do servidor), a confirmação ficaria
   * lá para sempre, ao lado de um status que a contradiz.
   *
   * A regra aqui é estreita e é a que resolve: **o que o estado diz agora
   * vence**. A mensagem de sucesso é de consulta única — aparece no retorno do
   * OAuth e sai assim que o estado confirma. Uma mensagem de erro, essa sim,
   * persiste, porque não é contrariada por um estado que voltou a ser bom.
   */
  const refresh = useCallback(async () => {
    try {
      const novo = await fetchDriveStatus();
      setStatus(novo);
      if (novo.connected) {
        setMessage((atual) => (atual && atual.startsWith('Conta do Drive conectada') ? null : atual));
        // Conectou: a espera acabou da forma boa, e o carimbo não pode sobrar
        // para acusar o próximo login.
        limparEspera();
      } else {
        // Conectado e depois desconectado sem passar por aqui: o estado manda,
        // e a confirmação antiga vira informação falsa.
        setMessage((atual) => (atual === 'Conta do Drive conectada.' ? null : atual));
        /*
         * O vigia. Só aqui que ele pode rodar: `refresh` é quem sabe que a
         * conta continua fora, e é ele que roda no foco de volta da janela do
         * Google — exatamente o instante em que a pessoa descobre que o login
         * não voltou.
         *
         * A ordem importa: a mensagem do vigia é escrita **depois** da limpeza
         * da confirmação, senão a regra de "o estado vence" apagaria a única
         * frase que explica a tela.
         */
        const quando = lerEspera();
        if (quando !== null && Date.now() - quando > ESPERA_MS) {
          limparEspera();
          setMessage(LOGIN_NAO_VOLTOU);
        }
      }
    } catch {
      setStatus(idle);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', aoVoltar);
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      window.removeEventListener('focus', aoVoltar);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [refresh]);

  // No navegador o callback volta para o app com `?drive=connected`, e a aba é a
  // mesma aba: a mensagem aparece aqui. No desktop o callback mostra a tela de
  // conclusão no navegador, e quem atualiza é o `refresh` do foco.
  const query = router.query.drive;

  useEffect(() => {
    if (!router.isReady) return;
    const aviso = mensagemDe(query);
    if (!aviso) return;
    /*
     * A confirmação é mostrada **antes** do `refresh` terminar, para não haver um
     * instante em que a tela não diz nada. O `refresh` decide se ela fica: se o
     * servidor responder que a conta não está conectada, o aviso de sucesso é
     * informação falsa e sai junto.
     *
     * A passagem por aqui também encerra a espera do vigia de `connect`: ter
     * qualquer `?drive=` na URL significa que o Google voltou, mesmo que com
     * `denied` ou `error`. A espera sem callback é bem pior que um erro
     * reportado, porque não deixa a pessoa distinguir "o Google recusou" de "o
     * botão não fez nada".
     */
    setMessage(aviso);
    /*
     * O Google voltou, mesmo que com recusa. O vigia não tem mais o que dizer,
     * e a mensagem de `denied`/`error` é mais específica que a de "não voltou" —
     * então aqui a espera é encerrada antes do `refresh` escrever por cima.
     */
    limparEspera();
    if (query === 'connected' || query === 'denied' || query === 'error') void refresh();
    const resto = { ...router.query };
    delete resto.drive;
    void router.replace({ pathname: router.pathname, query: resto }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, router.isReady, query]);

  const connect = useCallback(() => {
    const returnTo = typeof window !== 'undefined' ? window.location.href : '/';
    if (!isDesktop()) {
      /*
       * O carimbo vai antes da navegação, e isso é o ponto: a partir de
       * `location.assign` esta página deixa de existir, e sem o carimbo escrito
       * agora não sobraria nenhuma prova de que o login chegou a partir. Sem
       * ele, um Google que morre na tela de conta e um botão quebrado continuam
       * parecendo a mesma coisa.
       */
      marcarEspera();
      window.location.assign(driveConnectUrl(returnTo));
      return;
    }
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const resposta = await driveStartUrl(returnTo, 'pagina');
        if ('error' in resposta) {
          // O servidor recusou de saída: o login nem partiu, e não há espera
          // para vigiar.
          limparEspera();
          setError(
            resposta.error === 'not_configured'
              ? MENSAGENS.not_configured
              : 'Não foi possível iniciar a conexão com o Google Drive. Tente de novo.',
          );
          return;
        }
        /*
         * Só agora a URL existe, e é agora que o login pode mesmo ter partido.
         * No desktop a página **não** é descarregada — o app fica aberto atrás
         * do navegador do sistema —, então o carimbo do `sessionStorage` seria
         * de outra aba. Ele ainda serve: o `refresh` do foco roda no app, e é
         * nele que a espera é avaliada.
         */
        marcarEspera();
        const abriu = await window.juntosDesktop?.openInSystemBrowser(resposta.url);
        if (abriu === false) setError('Não consegui abrir o navegador para o login do Drive.');
      } catch {
        setError('Não foi possível iniciar a conexão com o Google Drive. Tente de novo.');
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectDrive();
      setStatus((prev) => ({ ...prev, connected: false }));
      setMessage('Conta do Google Drive desconectada.');
    } catch {
      setError('Não foi possível desconectar. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo(
    () => ({ status, loading, busy, message, error, connect, disconnect, refresh }),
    [status, loading, busy, message, error, connect, disconnect, refresh],
  );

  return <DriveAccountContext.Provider value={value}>{children}</DriveAccountContext.Provider>;
}

export function useDriveAccount(): DriveAccountValue {
  const ctx = useContext(DriveAccountContext);
  if (!ctx) throw new Error('useDriveAccount precisa do DriveAccountProvider');
  return ctx;
}
