'use client';

import { MusicNotes } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import { spotifyAccessToken } from '@/lib/spotifyAccount';
import { conectarPlayerSpotify, type MotivoDoAudio, type PlayerSpotify } from '@/lib/spotifyPlayback';

/**
 * O que a sala está tocando no Spotify.
 *
 * ## Este componente não reproduz nada, e é de propósito
 *
 * Toda outra fonte tem um player que o servidor dirige: o `<video>`, o
 * `YouTubePlayer`, o `DriveVideo`. Todos recebem o tempo do servidor e
 * sincronizam com a sala, e o áudio é **um só** — o mesmo que sai de todas as
 * máquinas, no mesmo instante.
 *
 * O Spotify não tem isso e não pode ter. Não existe URL de áudio, e o som é
 * entregue pelo Web Playback SDK **em cada navegador, com a conta de cada
 * pessoa**, direto do Spotify. Um player aqui seria um player só em uma máquina,
 * e a sala ouviria uma coisa e veria outra — pior do que não ter.
 *
 * Então este componente é apresentacional: mostra capa, título e **quem vai
 * ouvir**. O player é um recurso da sessão, mora em `useSpotifyPlayer`, e é
 * criado uma vez — não por faixa, porque a cada faixa o Spotify ganharia um
 * device_id novo e a lista de dispositivos do telefone da pessoa encheria de
 * "Juntos" repetido.
 *
 * O texto do meio não é enfeite. Sem ele, alguém sem Premium vê a capa e o
 * título de uma música e conclui que o app quebrou — e alguém com Premium, na
 * mesma sala, ouve. Duas experiências incompatíveis no mesmo vídeo, sem nenhuma
 * pista de por quê, é o pior formato possível.
 */
interface Props {
  title: string;
  artwork?: string;
  /** A conta desta pessoa está conectada no servidor. */
  conectado: boolean;
  /**
   * Se este navegador pode reproduzir.
   *
   * Vem do ambiente (contexto seguro, não-Electron, SDK carregado), e não do
   * `/me` — o `product` da conta não distingue Premium de Lite.
   */
  reproduz: boolean;
}

export function SpotifyStage({ title, artwork, conectado, reproduz }: Props) {
  if (!conectado) {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center">
        <MusicNotes size={28} className="text-[#1DB954]" />
        <p className="text-sm text-ink-muted">{title}</p>
        <p className="text-2xs leading-relaxed text-ink-faint">
          Conecte sua conta do Spotify para ouvir. Cada pessoa ouve com a conta dela, e o áudio
          precisa de Spotify Premium.
        </p>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
      {artwork && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={artwork}
          alt=""
          className="h-40 w-40 rounded-lg object-cover shadow-lift sm:h-52 sm:w-52"
        />
      )}
      <div className="min-w-0 max-w-sm">
        <p className="truncate text-sm font-medium text-ink">{title}</p>
        <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
          {reproduz
            ? 'Tocando pelo Spotify, na sua conta. Quem não tem Premium vê a faixa e não ouve o áudio.'
            : 'O Spotify não reproduz neste dispositivo. A faixa está na fila, e quem tem Premium ouve.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Conecta o player do Spotify desta pessoa e o entrega para quem manda play.
 *
 * Fica separado do componente acima porque os dois têm ciclos de vida
 * diferentes: o palco é desenhado a cada faixa, e o player é um recurso
 * **da sessão** — conectar um player por faixa criaria um dispositivo novo no
 * Spotify Connect a cada música, e a lista de saída de áudio do telefone da
 * pessoa encheria de "Juntos" repetido.
 */
export function useSpotifyPlayer(opts: {
  conectado: boolean;
  aoConectar: (player: PlayerSpotify | null) => void;
  aoMotivo: (motivo: MotivoDoAudio) => void;
}): { tocar: (uri: string) => Promise<void> } {
  const refPlayer = usePlayerRef(opts);

  return {
    tocar: async (uri: string) => {
      const player = refPlayer.current;
      if (!player) return;
      await player.tocar(uri);
    },
  };
}

function usePlayerRef(opts: {
  conectado: boolean;
  aoConectar: (player: PlayerSpotify | null) => void;
  aoMotivo: (motivo: MotivoDoAudio) => void;
}) {
  const ref = useRef<PlayerSpotify | null>(null);

  useEffect(() => {
    if (!opts.conectado) {
      ref.current?.destruir();
      ref.current = null;
      return;
    }

    let vivo = true;
    let player: PlayerSpotify | null = null;

    void conectarPlayerSpotify({
      /*
       * O nome aparece na lista de dispositivos do Spotify Connect da pessoa.
       * Sem um nome que a pessoa reconheça, ela não consegue escolher este
       * dispositivo como saída de áudio — e o player tocaria no alto-falante
       * errado sem nenhum aviso.
       */
      nomeDoPlayer: 'Juntos — esta sala',
      pedirToken: spotifyAccessToken,
      onMotivo: (motivo) => {
        if (vivo) opts.aoMotivo(motivo);
      },
    }).then((p) => {
      if (!vivo) {
        // O componente saiu enquanto o script carregava. Conectar mesmo assim
        // deixaria um device_id órfão no Spotify até a aba ser fechada.
        p?.destruir();
        return;
      }
      player = p;
      ref.current = p;
      opts.aoConectar(p);
    });

    return () => {
      vivo = false;
      player?.destruir();
      ref.current = null;
    };
  }, [opts.conectado, opts]);

  return ref;
}
