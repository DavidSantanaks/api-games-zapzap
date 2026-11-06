import test from 'node:test';
import assert from 'node:assert/strict';
import { cs2Messages, classifyCs2Performance, mapLabel, CS2_MESSAGE_VARIABLES } from '../src/cs2-message.js';
import { validateMessageConfig } from '../src/message.js';

test('CS2 preview scenarios cover feed, normal and carry KDA bands with map, score and ADR', () => {
  const feed = cs2Messages.createPreview('feed');
  assert.equal(feed.category, 'feed');
  assert.equal(feed.values.jogo, 'CS2');
  assert.equal(feed.values.modo, 'Premier');
  assert.equal(feed.values.mapa, 'Inferno');
  assert.equal(feed.values.placar, '7 x 13');
  assert.equal(feed.values.adr, '54,3');
  assert.equal(feed.values.kda, '0,65');
  assert.match(feed.message, /Jogo: CS2/);
  assert.match(feed.message, /Mapa: Inferno/);
  assert.match(feed.message, /ADR: 54,3/);

  const normal = cs2Messages.createPreview('normal');
  assert.equal(normal.category, 'normal');
  assert.equal(normal.values.kda, '1,36');
  assert.match(normal.message, /NÃO FEZ MAIS QUE A OBRIGAÇÃO/);

  const carry = cs2Messages.createPreview('carry');
  assert.equal(carry.category, 'carry');
  assert.equal(carry.values.kda, '3,09');
  assert.match(carry.message, /VITÓRIA 🟢/);

  assert.throws(() => cs2Messages.createPreview('support'), /feed, normal ou carry/);
});

test('CS2 KDA classification uses exact unrounded boundaries and supports draws and missing ADR', () => {
  assert.equal(classifyCs2Performance({ kills: 9, deaths: 10, assists: 0 }), 'feed');
  assert.equal(classifyCs2Performance({ kills: 10, deaths: 10, assists: 0 }), 'normal');
  assert.equal(classifyCs2Performance({ kills: 24, deaths: 10, assists: 0 }), 'normal');
  assert.equal(classifyCs2Performance({ kills: 25, deaths: 10, assists: 0 }), 'carry');

  const drawMatch = {
    id: 'CSGO-ruwBY-a8nzc-sf75U-PFq6w-GWRZQ',
    playerName: 'AmigoCS',
    mode: 'Competitivo',
    map: 'de_ancient_night',
    score: '12 x 12',
    result: 'draw',
    win: null,
    kills: 18,
    deaths: 18,
    assists: 4,
    adr: null,
    damage: null,
    rounds: null,
    mvps: null,
    headshotPercent: null,
    endedAt: '2026-11-06T14:00:00.000Z',
  };
  const rendered = cs2Messages.formatMessage(drawMatch);
  assert.equal(rendered.values.resultado, 'EMPATE');
  assert.equal(rendered.values.resultado_emoji, '🟡');
  assert.equal(rendered.values.mapa, 'Ancient Night');
  assert.equal(rendered.values.adr, 'N/A');
  assert.equal(rendered.values.dano, 'N/A');
  assert.equal(rendered.values.hs, 'N/A');
  assert.equal(mapLabel('de_dust2'), 'Dust2');
});

test('LoL and CS2 message validators enforce each game own variable catalog and categories', () => {
  assert.equal(CS2_MESSAGE_VARIABLES.length, 21);
  const cs2Config = cs2Messages.defaultConfig();
  assert.doesNotThrow(() => cs2Messages.validateConfig(cs2Config));

  const withLolField = structuredClone(cs2Config);
  withLolField.templates[0].text = 'Campeão: {{personagem}} {{zoeira}}';
  assert.throws(() => cs2Messages.validateConfig(withLolField), /variável não permitida/);

  const withSupportPool = structuredClone(cs2Config);
  withSupportPool.phrases.support = ['Frase de suporte'];
  assert.throws(() => cs2Messages.validateConfig(withSupportPool), /ausentes ou não permitidos/);

  const lolWithAdr = {
    templates: [{ id: 't1', name: 'Teste', enabled: true, text: 'ADR: {{adr}} {{zoeira}}' }],
    phrases: { feed: ['a'], normal: ['b'], carry: ['c'], support: ['d'] },
  };
  assert.throws(() => validateMessageConfig(lolWithAdr), /variável não permitida/);
});
