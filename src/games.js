import { lolMessages } from './message.js';
import { CS2_MATCH_FIELDS, cs2Messages } from './cs2-message.js';

// Registro dos jogos suportados. Cada jogo tem o próprio motor de mensagens e os próprios campos de prévia;
// WhatsApp, grupo, fila e monitor são compartilhados.
export const GAME_IDS = ['lol', 'cs2'];
export const GAMES = {
  lol: {
    id: 'lol', name: 'League of Legends', messages: lolMessages,
    previewFields: ['playerName', 'champion', 'kills', 'deaths', 'assists', 'cs', 'gold', 'lane', 'win', 'durationSeconds', 'endedAt', 'queueId', 'gameMode', 'mode'],
  },
  cs2: { id: 'cs2', name: 'Counter-Strike 2', messages: cs2Messages, previewFields: CS2_MATCH_FIELDS },
};

export const isGame = value => typeof value === 'string' && Object.hasOwn(GAMES, value);
export const messagesFor = game => GAMES[game].messages;
