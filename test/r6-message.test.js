import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeR6Match } from '../src/r6.js';
import { R6_CREDIT, classifyR6Performance, r6Messages } from '../src/r6-message.js';
import { r6Item } from './r6-fixtures.js';

const M1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const M2 = 'aaaaaaaa-0000-4000-8000-000000000002';

test('R6 praise needs KDA ≥ 4 and a win; loss, draw and abandon never get praise', () => {
  assert.equal(classifyR6Performance({ kills: 1, deaths: 5, assists: 1, result: 'loss' }), 'feed');
  assert.equal(classifyR6Performance({ kills: 6, deaths: 2, assists: 1, result: 'win' }), 'normal', 'KDA 3,5 não basta');
  assert.equal(classifyR6Performance({ kills: 6, deaths: 2, assists: 2, result: 'win' }), 'carry');
  assert.equal(classifyR6Performance({ kills: 20, deaths: 1, assists: 0, result: 'loss', outcome: 'abandon' }), 'normal');
  assert.equal(classifyR6Performance({ kills: 20, deaths: 1, assists: 0, result: 'draw' }), 'normal');
});

test('R6 messages render variables, N/A and the fixed Stats.cc credit', () => {
  const match = normalizeR6Match(r6Item(M1, {}, { outcome: 'abandon', kills: 1, deaths: 6, assists: 0 }), { player: { platformLabel: 'PC' } });
  const { message, values, category } = r6Messages.formatMessage(match);
  assert.equal(category, 'feed');
  assert.equal(values.resultado, 'ABANDONO');
  assert.equal(values.resultado_emoji, '🔴');
  assert.equal(values.pontos, '+23');
  assert.equal(values.aberturas, '2/1');
  assert.equal(values.plataforma, 'PC');
  assert.ok(message.endsWith(`\n\n${R6_CREDIT}`), 'crédito no fim');
  // O crédito não depende do modelo: um modelo editado sem ele continua com o rodapé.
  const config = r6Messages.defaultConfig();
  config.templates = [{ id: 'curto', name: 'Curto', enabled: true, text: '{{player}} {{pontos}} {{rank}} {{hs}}' }];
  const unranked = normalizeR6Match(r6Item(M2, { playlist: 'unranked', ranked_session: null }, { headshots: null }));
  assert.equal(r6Messages.formatMessage(unranked, { config }).message, `AmigoR6 N/A N/A N/A\n\n${R6_CREDIT}`);
  for (const scenario of ['feed', 'normal', 'carry']) assert.equal(r6Messages.createPreview(scenario).category, scenario);
  assert.throws(() => r6Messages.validateConfig({ ...config, templates: [{ ...config.templates[0], text: '{{lane}}' }] }), /variável não permitida/);
});
