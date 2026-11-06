import test from 'node:test';
import assert from 'node:assert/strict';
import { gameModeLabel } from '../src/game-mode.js';
import { createPreview, formatMessage, getDefaultMessageConfig, MESSAGE_VARIABLES } from '../src/message.js';

test('known queues distinguish ranked, normal, ARAM and current alternate modes', () => {
  for (const [queueId, label] of [
    [420, 'Ranqueada Solo/Duo'], [440, 'Ranqueada Flex'], [400, 'Normal alternada'],
    [430, 'Normal às cegas'], [450, 'ARAM'], [480, 'Swiftplay'], [490, 'Jogo rápido'],
    [900, 'ARURF'], [1900, 'URF'], [1700, 'Arena'], [1710, 'Arena'],
    [2300, 'Brawl'], [2400, 'ARAM: Mayhem'], [880, 'Co-op vs IA — iniciante'],
  ]) assert.equal(gameModeLabel({ queueId, gameMode: 'CLASSIC' }), label, String(queueId));
});

test('queue mode resolution supports old records and avoids misleading cached labels', () => {
  assert.equal(gameModeLabel({ queueId: 440 }), 'Ranqueada Flex');
  assert.equal(gameModeLabel({ queueId: '450' }), 'ARAM');
  assert.equal(gameModeLabel({ queueId: 420, mode: 'Normal', gameMode: 'CLASSIC' }), 'Ranqueada Solo/Duo');
  assert.equal(gameModeLabel({ queueId: 0 }), 'Personalizada');
});

test('unknown queues safely fall back to raw mode or explicit queue identifier', () => {
  assert.equal(gameModeLabel({ queueId: 999999, gameMode: 'URF' }), 'URF');
  assert.equal(gameModeLabel({ queueId: 999999, gameMode: 'FUTURE_MODE' }), 'FUTURE_MODE');
  assert.equal(gameModeLabel({ queueId: 999999 }), 'Fila 999999');
  for (const queueId of [undefined, null, '', 'invalid', -1, NaN]) {
    assert.equal(gameModeLabel({ queueId }), 'Modo desconhecido');
  }
  assert.equal(gameModeLabel({ gameMode: 'CLASSIC' }), 'Clássico');
  assert.equal(gameModeLabel({ gameMode: 'X'.repeat(500) }).length, 128);
});

test('mode is available in message templates and phrase variables for old and new matches', () => {
  const config = getDefaultMessageConfig();
  config.templates[0].text = 'Modo: {{modo}}\n{{zoeira}}';
  config.phrases.feed = ['{{nick}} fez {{frag}} na {{modo}}'];
  const { match } = createPreview('feed');
  const result = formatMessage({ ...match, queueId: 450, gameMode: undefined, mode: undefined }, { config });
  assert.equal(result.values.modo, 'ARAM');
  assert.equal(result.message, 'Modo: ARAM\nSeuAmigo fez 1/8/3 na ARAM');
  assert.ok(MESSAGE_VARIABLES.some(variable => variable.key === 'modo' && variable.label === 'Modo de jogo'));
  for (const preset of getDefaultMessageConfig().templates) assert.ok(preset.text.includes('\nModo: {{modo}}\n'));
});
