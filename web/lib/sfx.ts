import type { SoundId } from '@/types';

let ctx: AudioContext | null = null;
let isAudioUnlocked = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** 
 * Desbloqueia o AudioContext na primeira interação real do usuário na página.
 */
export function unlockAudio() {
  const audio = getCtx();
  if (!audio) return;

  if (audio.state === 'suspended') {
    audio.resume().then(() => {
      isAudioUnlocked = true;
    });
  } else {
    isAudioUnlocked = true;
  }
}

// Configura listeners globais para capturar qualquer primeiro clique do usuário
if (typeof window !== 'undefined') {
  const unlockEvents = ['click', 'touchstart', 'keydown'];
  const handleUserInteraction = () => {
    unlockAudio();
    if (isAudioUnlocked) {
      unlockEvents.forEach((event) => window.removeEventListener(event, handleUserInteraction));
    }
  };

  unlockEvents.forEach((event) => window.addEventListener(event, handleUserInteraction, { once: false }));
}

/** Rajada de ruído filtrado — base de palmas e do "corpo" do tambor. */
function noiseBurst(duration: number, gainPeak: number, filterFreq: number, delay = 0) {
  const audio = getCtx();
  if (!audio) return;

  // Garante o resume caso tenha sido suspenso
  if (audio.state === 'suspended') void audio.resume();

  const bufferSize = Math.max(1, Math.floor(audio.sampleRate * duration));
  const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const source = audio.createBufferSource();
  source.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;

  const gain = audio.createGain();
  const start = audio.currentTime + delay;
  gain.gain.setValueAtTime(gainPeak, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

  source.connect(filter).connect(gain).connect(audio.destination);
  source.start(start);
  source.stop(start + duration + 0.02);
}

/** Tom simples com ataque/decaimento suaves — base de risada e "uau". */
function tone(freq: number, duration: number, type: OscillatorType, gainPeak: number, delay = 0) {
  const audio = getCtx();
  if (!audio) return;

  // Garante o resume caso tenha sido suspenso
  if (audio.state === 'suspended') void audio.resume();

  const osc = audio.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;

  const gain = audio.createGain();
  const start = audio.currentTime + delay;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playClap() {
  noiseBurst(0.09, 0.5, 1800);
  noiseBurst(0.07, 0.35, 2200, 0.07);
  noiseBurst(0.09, 0.4, 1600, 0.15);
}

function playLaugh() {
  [0, 0.14, 0.28, 0.42].forEach((delay, i) => tone(320 + i * 14, 0.12, 'sawtooth', 0.12, delay));
}

function playWow() {
  tone(440, 0.5, 'sine', 0.18, 0);
  tone(660, 0.4, 'sine', 0.12, 0.08);
}

function playDrum() {
  noiseBurst(0.25, 0.4, 130);
  tone(90, 0.25, 'sine', 0.3, 0);
}

export function playSound(id: SoundId) {
  playSoundDirect(id);
}

function playSoundDirect(id: SoundId) {
  unlockAudio(); // Força a tentativa de ativacão ao enviar/receber som

  if (id === 'clap') playClap();
  else if (id === 'laugh') playLaugh();
  else if (id === 'wow') playWow();
  else if (id === 'drum') playDrum();
}