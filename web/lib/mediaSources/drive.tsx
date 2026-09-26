import { GoogleDriveLogo } from '@phosphor-icons/react';
import type { MediaSourceProvider } from './types';
import { unavailable } from './types';

/**
 * Google Drive.
 *
 * A integração existe no modal desde já, mas fica indisponível: o item de
 * playlist atual guarda `kind` + `src`, e o Drive não entrega um link direto de
 * vídeo reproduzível no navegador — precisaria de proxy no servidor, com
 * autenticação por sala. Esse trabalho é de backend e fica de fora desta
 * entrega.
 *
 * A entrada está aqui de propósito: mostra que "aplicação indisponível" é um
 * estado de primeira classe, e o lugar do código já está reservado para quando
 * o proxy existir.
 */
export const driveProvider: MediaSourceProvider = {
  id: 'drive',
  name: 'Google Drive',
  description: 'Vídeos do seu Drive. Em breve.',
  // Triângulo oficial do Drive, não um ícone genérico de nuvem: a marca é
  // reconhecível só pelo triângulo, e o Phosphor já traz a forma certa.
  icon: <GoogleDriveLogo size={22} weight="fill" />,
  accent: 'text-sky-300',
  resolveState: async () => unavailable('O Drive precisa de um servidor intermediário. Em breve.'),
};
