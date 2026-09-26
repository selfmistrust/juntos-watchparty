'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';
import type { LiveStream } from '@/types';

/**
 * WebRTC para a tela compartilhada.
 *
 * O servidor só entrega as mensagens de negociação; a mídia vai por conexão
 * direta. O modelo é um para muitos: quem transmite mantém uma
 * `RTCPeerConnection` por espectador, todas alimentadas pelo mesmo
 * `MediaStream`. A captura acontece uma vez, independente de quantas pessoas
 * estão olhando.
 *
 * Quem cria a oferta é quem tem a mídia. Uma oferta precisa anunciar um tipo de
 * mídia, e só o dono sabe qual é. O espectador responde e manda candidates.
 *
 * A configuração de ICE é o ponto que trava sem explicação. Um TURN não está
 * configurado (o projeto não tem servidor de mídia), então a conexão só sai
 * entre duas pessoas na mesma rede. Não é bug: é o limite do que dá para
 * prometer sem infraestrutura de relay. A sala mostra o estado real em vez de
 * ficar girando.
 */

const ICE: RTCConfiguration = {
  // Gather mais cedo, para a primeira tentativa já ter candidato de host.
  iceServers: [],
  iceCandidatePoolSize: 2,
};

export interface StreamController {
  /** Estado para a interface. */
  status: 'idle' | 'publishing' | 'receiving' | 'connecting' | 'failed';
  /** A transmissão em que estou PUBLICANDO (ou null). */
  transmitting: LiveStream | null;
  /** O `MediaStream` que estou PUBLICANDO — a prévia e o envio às conexões. */
  meuStream: MediaStream | null;
  /** O `MediaStream` que estou RECEBENDO de outra pessoa. */
  remoto: MediaStream | null;
  /** Erro legível, quando houver. */
  erro: string | null;
  /** Começa a transmitir. */
  publicar: (stream: MediaStream, title?: string) => Promise<void>;
  /** Para de transmitir. */
  parar: () => void;
  /** Assina a transmissão em andamento (usado quando a faixa é selecionada). */
  assinar: (streamId: string) => void;
  /** Cancela a assinatura. */
  cancelar: (streamId: string) => void;
}

/**
 * `socket` é o mesmo do `useRoom` (instância única por aba). As conexões
 * WebRTC vivem em refs porque elas **não** são estado de render: recriá-las a
 * cada render derrubaria a conexão a cada tecla digitada.
 */
export function useStreamBridge(): StreamController {
  const [status, setStatus] = useState<StreamController['status']>('idle');
  const [transmitindo, setTransmitindo] = useState<LiveStream | null>(null);
  const [meuStream, setMeuStream] = useState<MediaStream | null>(null);
  const [remoto, setRemoto] = useState<MediaStream | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  /** Coneções que EU criei, por socket.id do espectador. */
  const paraEspectadores = useRef(new Map<string, RTCPeerConnection>());
  /** Coneções que EU criei para me conectar a outra pessoa, por streamId. */
  const paraDonos = useRef(new Map<string, RTCPeerConnection>());
  /** A transmissão que estou publicando, para limpar na hora. */
  const publicando = useRef<{ id: string; stream: MediaStream } | null>(null);
  /** A transmissão que estou assinando. */
  const assistindo = useRef<string | null>(null);

  const signaling = useCallback(() => {
    const socket = getSocket();
    const meu = publicando.current;

    // --- Sou o DONO: alguém quer assistir ----------------------------------
    const aoEntrarEspectador = async (p: { streamId: string; peerSessionId: string }) => {
      if (!meu || meu.id !== p.streamId) return;

      // Uma oferta por espectador. Se já existe uma para ele, refaz: o
      // espectador pode ter recarregado a página e perdido a conexão antiga.
      paraEspectadores.current.get(p.peerSessionId)?.close();
      const pc = new RTCPeerConnection(ICE);
      paraEspectadores.current.set(p.peerSessionId, pc);

      for (const track of meu.stream.getTracks()) {
        pc.addTrack(track, meu.stream);
      }

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        socket.emit('stream:signal', {
          to: p.peerSessionId,
          streamId: p.streamId,
          data: { candidate: e.candidate.toJSON() },
        });
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('stream:signal', {
        to: p.peerSessionId,
        streamId: p.streamId,
        data: { sdp: pc.localDescription },
      });
    };

    const aoSairEspectador = (p: { streamId: string; peerSessionId: string }) => {
      if (!meu || meu.id !== p.streamId) return;
      paraEspectadores.current.get(p.peerSessionId)?.close();
      paraEspectadores.current.delete(p.peerSessionId);
    };

    // --- Sou o ESPECTADOR: o dono me respondeu ----------------------------
    const aoReceberSinal = async (p: { from: string; streamId: string; data: unknown }) => {
      const dados = p.data as {
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };
      if (!dados) return;

      // O mesmo `stream:signal` atende os dois papéis; qual deles é o meu
      // depende de quem está transmitindo, e não do conteúdo da mensagem.
      if (publicando.current?.id === p.streamId) {
        const pc = paraEspectadores.current.get(p.from);
        if (!pc) return;
        if (dados.sdp) await pc.setRemoteDescription(dados.sdp);
        if (dados.candidate) await pc.addIceCandidate(dados.candidate).catch(() => undefined);
        return;
      }

      if (assistindo.current !== p.streamId) return;
      let pc = paraDonos.current.get(p.streamId);
      if (!pc) {
        setStatus('connecting');
        // `const` de propósito: um `let` seria reatribuído logo abaixo, e o
        // TypeScript não garante nada dentro dos closures que o capturam.
        const nova = new RTCPeerConnection(ICE);
        pc = nova;
        paraDonos.current.set(p.streamId, nova);

        // `ontrack` é onde a mídia chega: pode ser mais de uma vez, então o
        // fluxo é montado a partir das faixas, não do evento.
        const recebido = new MediaStream();
        nova.ontrack = (e) => {
          for (const track of e.streams[0]?.getTracks() ?? [e.track]) {
            recebido.addTrack(track);
          }
          setRemoto(recebido);
          setStatus('receiving');
        };

        nova.onicecandidate = (e) => {
          if (!e.candidate) return;
          socket.emit('stream:signal', {
            to: p.from,
            streamId: p.streamId,
            data: { candidate: e.candidate.toJSON() },
          });
        };

        // Sem isto, uma conexão que morre no meio deixa a sala esperando para
        // sempre, com o player preto e sem explicação.
        nova.onconnectionstatechange = () => {
          if (nova.connectionState === 'failed' || nova.connectionState === 'disconnected') {
            setErro('A transmissão não foi estabelecida. Talvez você esteja em redes diferentes.');
            setStatus('failed');
            setRemoto(null);
          }
        };
      }

      if (dados.sdp) {
        await pc.setRemoteDescription(dados.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('stream:signal', {
          to: p.from,
          streamId: p.streamId,
          data: { sdp: pc.localDescription },
        });
      }
      if (dados.candidate) await pc.addIceCandidate(dados.candidate).catch(() => undefined);
    };

    const aoIniciar = (p: { stream: LiveStream }) => {
      setTransmitindo(p.stream);
      setStatus('publishing');
    };

    const aoParar = (p: { streamId: string }) => {
      if (publicando.current?.id === p.streamId) {
        publicando.current = null;
        paraEspectadores.current.forEach((pc) => pc.close());
        paraEspectadores.current.clear();
        setTransmitindo(null);
        setMeuStream(null);
        setStatus('idle');
      }
      if (assistindo.current === p.streamId) {
        paraDonos.current.get(p.streamId)?.close();
        paraDonos.current.delete(p.streamId);
        assistindo.current = null;
        setRemoto(null);
        setStatus('idle');
      }
    };

    socket.on('stream:started', aoIniciar);
    socket.on('stream:stopped', aoParar);
    socket.on('stream:peer-join', aoEntrarEspectador);
    socket.on('stream:peer-leave', aoSairEspectador);
    socket.on('stream:signal', aoReceberSinal);

    return () => {
      socket.off('stream:started', aoIniciar);
      socket.off('stream:stopped', aoParar);
      socket.off('stream:peer-join', aoEntrarEspectador);
      socket.off('stream:peer-leave', aoSairEspectador);
      socket.off('stream:signal', aoReceberSinal);
    };
  }, []);

  // Um ciclo do `useEffect` para toda a vida do hook: os listeners do socket
  // entram e saem com o componente, e as conexões WebRTC vivem em refs para
  // não nascerem a cada render.
  useEffect(() => signaling(), [signaling]);

  // Fechar a aba tem que derrubar as conexões, senão o dono continua
  // transmitindo para ninguém até o timeout do servidor.
  useEffect(() => {
    const aoSair = () => {
      paraEspectadores.current.forEach((pc) => pc.close());
      paraEspectadores.current.clear();
      paraDonos.current.forEach((pc) => pc.close());
      paraDonos.current.clear();
    };
    window.addEventListener('beforeunload', aoSair);
    return () => window.removeEventListener('beforeunload', aoSair);
  }, []);

  const publicar = useCallback(async (stream: MediaStream, title?: string) => {
    const socket = getSocket();
    setErro(null);
    // Guardado antes do emit: um `stream:peer-join` pode chegar no mesmo tick
    // do `publish`, e sem o registro o dono ignoraria o primeiro espectador.
    publicando.current = { id: '', stream };
    setMeuStream(stream);
    socket.emit('stream:publish', { title });
  }, []);

  const parar = useCallback(() => {
    const atual = publicando.current;
    if (!atual?.id) return;
    getSocket().emit('stream:unpublish', { streamId: atual.id });
    paraEspectadores.current.forEach((pc) => pc.close());
    paraEspectadores.current.clear();
    publicando.current = null;
    setTransmitindo(null);
    setMeuStream(null);
    setStatus('idle');
  }, []);

  const assinar = useCallback(
    (streamId: string) => {
      // A pessoa que transmite não assina a própria transmissão: ela já tem a
      // mídia local, e um round-trip de WebRTC só faria a prévia atrasar.
      if (publicando.current) return;
      if (assistindo.current === streamId) return;
      assistindo.current = streamId;
      setStatus('connecting');
      getSocket().emit('stream:subscribe', { streamId });
    },
    [],
  );

  const cancelar = useCallback((streamId: string) => {
    if (assistindo.current !== streamId) return;
    getSocket().emit('stream:unsubscribe', { streamId });
    paraDonos.current.get(streamId)?.close();
    paraDonos.current.delete(streamId);
    assistindo.current = null;
    setRemoto(null);
    setStatus('idle');
  }, []);

  // O dono precisa descobrir o id da própria transmissão. Ele chega no
  // `stream:started`, que é registrado no `aoIniciar` acima — por isso o
  // registro local é costurado aqui, no effect que depende do estado.
  useEffect(() => {
    if (publicando.current && transmitindo && !publicando.current.id) {
      publicando.current.id = transmitindo.id;
    }
  }, [transmitindo]);

  return {
    status,
    transmitting: transmitindo,
    meuStream,
    remoto,
    erro,
    publicar,
    parar,
    assinar,
    cancelar,
  };
}
